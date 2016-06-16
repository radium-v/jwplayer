define(['../utils/underscore',
        '../utils/id3Parser',
        '../utils/helpers',
        '../utils/dom',
        '../controller/captions',
        '../parsers/parsers',
        '../parsers/captions/srt',
        '../parsers/captions/dfxp',
        '../polyfills/vtt'
], function(_, ID3Parser, utils, dom, Captions, parsers, srt, dfxp, VTT) {
    /**
     * Used across caterpillar, html5 and dash providers for handling text tracks actions and events
     */
    var Tracks = {
        addTracksListener: addTracksListener,
        clearTracks: clearTracks,
        disableTextTrack: disableTextTrack,
        getSubtitlesTrack: getSubtitlesTrack,
        removeTracksListener: removeTracksListener,
        setTextTracks: setTextTracks,
        setupSideloadedTracks: setupSideloadedTracks,
        setSubtitlesTrack: setSubtitlesTrack,
        textTrackChangeHandler: textTrackChangeHandler,
        loadPolyfill: loadPolyfill
    };

    var _textTracks = null, // subtitles and captions tracks
        _textTracksCache = null,
        _currentTextTrackIndex = -1, // captionsIndex - 1 (accounts for Off = 0 in model)
        _embeddedTrackCount = 0,
        _unknownCount = 0,
        _corsAllowed = true,
        _renderNatively = false;


    function setTextTracks() {
        var tracks = this.video.textTracks;
        _currentTextTrackIndex = -1;
        if (!tracks) {
            return;
        }

        if (!_textTracks) {
            _initTextTracks();
        }

        //filter for 'subtitles' or 'captions' tracks
        if (tracks.length) {
            var i = 0, len = tracks.length;
            _embeddedTrackCount = 0;

            for (i; i < len; i++) {
                var track = tracks[i];
                if (_textTracksCache[i + track.id]) {
                    continue;
                }
                if (track.kind === 'metadata') {
                    track.oncuechange = _cueChangeHandler.bind(this);
                    track.mode = 'showing';
                    _textTracksCache[i + track.kind] = track;

                    if (track.label === 'ID3 Metadata') {
                        _embeddedTrackCount++;
                    }
                }
                else if (track.kind === 'subtitles' || track.kind === 'captions') {
                    // By setting the track mode to 'hidden', we can determine if the 608 track has cues
                    var mode = track.mode;
                    track.mode = 'hidden';
                    if (!track.cues.length && this.getName().name === 'caterpillar' && track.label === 'Unknown CC') {
                        // There's no method to remove tracks added via: video.addTextTrack in caterpillar.
                        // This ensures the 608 captions track isn't added until it has cues
                        continue;
                    }
                    track.mode = mode;
                    _addTrackToList(track);

                    if (track.embedded) {
                        _embeddedTrackCount++;
                    }
                }
            }
        }
        this.addTracksListener(tracks, 'change', textTrackChangeHandler);
        if (_textTracks && _textTracks.length) {
            this.trigger('subtitlesTracks', {tracks: _textTracks});
        }
    }

    function setupSideloadedTracks(tracks) {
        _renderNatively = _nativeRenderingSupported(this.getName().name);
        if (this._isSDK || !tracks) {
            return;
        }
        // Add tracks if we're starting playback or resuming after a midroll
        if (!_tracksAlreadySideloaded(tracks)) {
            disableTextTrack();
            dom.emptyElement(this.video);
            _clearSideloadedTextTracks();
            this.itemTracks = tracks;
            _addTracks.call(this, tracks);
        }

        if(!_renderNatively && _textTracks && _textTracks.length) {
            this.trigger('subtitlesTracks', {tracks: _textTracks});
        }
    }

    function setSubtitlesTrack (index) {
        if (!_textTracks) {
            return;
        }

        // 0 = 'Off'
        if (index === 0) {
            _.each(_textTracks, function (track) {
                track.mode = 'disabled';
            });
        }

        // Track index is 1 less than controlbar index to account for 'Off' = 0.
        // Prevent unnecessary track change events
        if (_currentTextTrackIndex === index - 1) {
            return;
        }

        // Turn off current track
        disableTextTrack();

        // Set the provider's index to the model's index, then show the selected track if it exists
        _currentTextTrackIndex = index - 1;
        if (_textTracks[_currentTextTrackIndex]) {
            _textTracks[_currentTextTrackIndex].mode = 'showing';
        }

        // Update the model index if change did not originate from controlbar or api
        this.trigger('subtitlesTrackChanged', {
            currentTrack: _currentTextTrackIndex + 1,
            tracks: _textTracks
        });
    }

    function getSubtitlesTrack() {
        return _currentTextTrackIndex;
    }

    function addTracksListener (tracks, eventType, handler) {
        handler = handler.bind(this);

        if (tracks.addEventListener) {
            tracks.addEventListener(eventType, handler);
        } else {
            tracks['on' + eventType] = handler;
        }
    }

    function removeTracksListener (tracks, eventType, handler) {
        if (!tracks) {
            return;
        }
        if (tracks.removeEventListener) {
            tracks.removeEventListener(eventType, handler);
        } else {
            tracks['on' + eventType] = null;
        }
    }

    function loadPolyfill (resolve) {
        //asyncLoad('../', callback) {
        //callback();
        //


        //if (!_renderNatively && !window.WebVTT) {
        //    require.ensure(['polyfills/vtt'], function (require) {
        //        require('polyfills/vtt');
        //        resolve();
        //    }, 'polyfills.vtt');
        //} else {
        //    resolve();
        //}
    }

    function clearTracks() {
        _textTracks = null;
        _textTracksCache = null;
        _embeddedTrackCount = 0;
    }

    function disableTextTrack() {
        if (_textTracks && _textTracks[_currentTextTrackIndex]) {
            _textTracks[_currentTextTrackIndex].mode = 'disabled';
        }
    }

    function textTrackChangeHandler () {

        if (!_textTracks) {
            //if tracks/cues are first added after the loadeddata event...
            this.setTextTracks();
        } else {
            // if a caption/subtitle track is showing, find its index
            var _selectedTextTrackIndex = -1, i = 0;
            for (i; i < _textTracks.length; i++) {
                if (_textTracks[i].mode === 'showing') {
                    _selectedTextTrackIndex = i;
                    break;
                }
            }
            this.setSubtitlesTrack(_selectedTextTrackIndex + 1);
        }
    }

    function _cueChangeHandler(e) {
        var activeCues = e.currentTarget.activeCues;
        if (!activeCues || !activeCues.length) {
            return;
        }

        // Get the most recent start time. Cues are sorted by start time in ascending order by the browser
        var startTime = activeCues[activeCues.length - 1].startTime;

        var dataCues = [];

        _.each(activeCues, function(cue) {
            if (cue.startTime < startTime) {
                return;
            }
            if (cue.data) {
                dataCues.push(cue);
            } else if (cue.text) {
                this.trigger('meta', {
                    metadataTime: startTime,
                    metadata: JSON.parse(cue.text)
                });
            }
        }, this);

        if (dataCues.length) {
            var id3Data = ID3Parser.parseID3(dataCues);
            this.trigger('meta', {
                metadataTime: startTime,
                metadata: id3Data
            });
        }
    }

    function _tracksAlreadySideloaded(tracks) {
        // Determine if the tracks are the same and the embedded + sideloaded count = # of tracks in the controlbar
        return tracks === this.itemTracks && _textTracks &&
            _textTracks.length === (_embeddedTrackCount + this.itemTracks.length);
    }

    function _clearSideloadedTextTracks() {
        // Clear VTT textTracks
        if(!_textTracks) {
            return;
        }
        var nonVTTTracks = _.filter(_textTracks, function (track) {
            return track.label === 'Unknown CC' || track.label === 'ID3 Metadata';
        });
        _initTextTracks();
        _.each(nonVTTTracks, function (track, index) {
           _textTracksCache[index + track] = track;
        });
        _textTracks = nonVTTTracks;
    }

    function _initTextTracks() {
        _textTracks = [];
        _textTracksCache = {};
    }

    function _addTracks(tracks) {
        // TODO: 1A) optimistically add track to videotag if native rendering supported OR
        // TODO: 1B) add to _textTracks now, since setTextTracks won't be called later
        // TODO: 2)  parse non-VTT tracks into cues
        // TODO: 3A) append cues to HTML track already in DOM
        // TODO: 3B) append cues to track in _textTracks by ID
        if (!tracks) {
            return;
        }

        var crossoriginAnonymous = false;
        if (!_textTracks) {
            _initTextTracks();
        }

        for (var i = 0; i < tracks.length; i++) {
            var itemTrack = tracks[i];
            var track = _createTrack(itemTrack, this.video);

            if ((/\.(?:web)?vtt(?:\?.*)?$/i).test(itemTrack.file)) {
                // VTT track
                // only add valid kinds https://developer.mozilla.org/en-US/docs/Web/HTML/Element/track
                if (!(/subtitles|captions|descriptions|chapters|metadata/i).test(itemTrack.kind)) {
                    continue;
                }

                if (!crossoriginAnonymous) {
                    // CORS applies to track loading and requires the crossorigin attribute
                    if (!this.video.hasAttribute('crossorigin') && utils.crossdomain(itemTrack.file)) {
                        this.video.setAttribute('crossorigin', 'anonymous');
                        crossoriginAnonymous = true;
                    }
                }

                if(_renderNatively && _corsAllowed) {
                    // TODO: Check for CORS issues and instead, load the file via parsing
                    track.src = itemTrack.file;
                    // add VTT track directly to the video element
                    this.video.appendChild(track);
                } else {
                    // parse track into cues
                    _addTrackToList(track);
                    _parseTrack(itemTrack, track);
                }
            } else {
                // Non-VTT track. Add track now and parse the cues async
                if(_renderNatively) {
                    this.video.appendChild(track);
                } else {
                    _addTrackToList(track);
                }
                _parseTrack(itemTrack, track);
            }
        }
    }

    function _addTrackToList(track) {
        _textTracks.push(track);
        _textTracksCache[track.id] = track;
    }

    function _parseTrack(itemTrack, track) {
        utils.ajax(itemTrack.file, function(xhr) {
            _xhrSuccess(xhr, track);
        }, _errorHandler);
    }

    function _xhrSuccess(xhr, track) {
        var rss = xhr.responseXML ? xhr.responseXML.firstChild : null;
        var status;

        // IE9 sets the firstChild element to the root <xml> tag
        if (rss) {
            if (parsers.localName(rss) === 'xml') {
                rss = rss.nextSibling;
            }
            // Ignore all comments
            while (rss.nodeType === rss.COMMENT_NODE) {
                rss = rss.nextSibling;
            }
        }
        try {
            if (rss && parsers.localName(rss) === 'tt') {
                // parse dfxp track
                status = utils.tryCatch(function () {
                    var cues = dfxp(xhr.responseXML);
                    var vttCues = _convertToVTTCues(cues);
                    _addCuesToTrack(track, vttCues);
                });
            } else {
                // parse VTT/SRT track
                status = utils.tryCatch(function () {
                    var responseText = xhr.responseText;
                    if(responseText.indexOf('WEBVTT') !== -1) {
                        // make VTTCues from VTT track
                        _parseCuesFromText(xhr.responseText, track);
                    } else {
                        // make VTTCues from SRT track
                        var cues = srt(xhr.responseText);
                        var vttCues = _convertToVTTCues(cues);
                        _addCuesToTrack(track, vttCues);
                    }
                });
            }
        } catch (error) {
            if (status instanceof utils.Error) {
                _errorHandler(status.message + ': ' + track.file);
            }
        }
    }

    function _addCuesToTrack(track, vttCues) {
        if(_renderNatively) {
            track.addCues(vttCues);
        } else {
            track.data = vttCues;
        }
    }

    function _createTrack(itemTrack) {
        var track;
        if (_renderNatively) {
            track = document.createElement('track');
            track.kind    = itemTrack.kind;
            track.srclang = itemTrack.language || '';
            track.label   = itemTrack.label;
            track.mode    = 'disabled';
        } else {
            track = itemTrack;
            track.data = track.data || [];
        }

        track.id = itemTrack.default || itemTrack.defaulttrack ? 'default' : '';
        if(!track.id) {
            track.id = track.name || track.file || ('cc' + _textTracks.length);
        }

        if (!track.label) {
            track.label = 'Unknown CC'; // TODO: avoid name collission with embedded Unknown CC track
            _unknownCount++;
            if (_unknownCount > 1) {
                track.label += ' [' + _unknownCount + ']';
            }
        }

        return track;
    }

    function _convertToVTTCues(cues) {
        var VTTCue = window.VTTCue;
        var vttCues = _.map(cues, function (cue) {
            return new VTTCue(cue.begin, cue.end, cue.text);
        });
        return vttCues;
    }

    function _parseCuesFromText(srcContent, track) {
        var WebVTT = VTT.WebVTT;
        var parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
        parser.oncue = function(cue) {
            if(_renderNatively) {
                track.addCue(cue);
            } else {
                track.data.push(cue);
            }
        };

        parser.onparsingerror = function(error) {
            console.log(error);
        };

        parser.onflush = function() {
            // TODO: event saying track is done being parsed
        };

        parser.parse(srcContent);
        parser.flush();
    }

    function _errorHandler(error) {
        utils.log('CAPTIONS(' + error + ')');
    }

    function _nativeRenderingSupported(providerName) {
        return providerName !== 'flash' && utils.isChrome() || utils.isIOS() || utils.isSafari();
    }

    return Tracks;
});