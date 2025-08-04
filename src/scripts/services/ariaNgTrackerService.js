(function () {
    'use strict';

    angular.module('ariaNg').factory('ariaNgTrackerService', ['$http', '$q', '$timeout', '$interval', 'ariaNgLogService', 'ariaNgSettingService', 'aria2SettingService', function ($http, $q, $timeout, $interval, ariaNgLogService, ariaNgSettingService, aria2SettingService) {
        var updateInterval = null;
        var isUpdating = false;

        var parseTrackers = function (trackerText) {
            if (!trackerText) {
                return [];
            }

            var trackers = [];
            var lines = trackerText.split(/\r?\n/);

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line && !line.startsWith('#') && (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('udp://'))) {
                    trackers.push(line);
                }
            }

            return trackers;
        };

        var fetchTrackersFromSource = function (sourceUrl) {
            ariaNgLogService.info('[ariaNgTrackerService.fetchTrackersFromSource] fetching from:', sourceUrl);

            return $http.get(sourceUrl, {
                timeout: 10000,
                headers: {
                    'Accept': 'text/plain'
                }
            }).then(function (response) {
                if (response.data) {
                    var trackers = parseTrackers(response.data);
                    ariaNgLogService.info('[ariaNgTrackerService.fetchTrackersFromSource] fetched', trackers.length, 'trackers from', sourceUrl);
                    return trackers;
                } else {
                    throw new Error('Empty response');
                }
            }).catch(function (error) {
                ariaNgLogService.warn('[ariaNgTrackerService.fetchTrackersFromSource] failed to fetch from', sourceUrl, error);
                throw error;
            });
        };

        var updateAria2Trackers = function (trackers) {
            if (!trackers || trackers.length === 0) {
                return $q.resolve();
            }

            var deferred = $q.defer();

            // Get current bt-tracker setting
            aria2SettingService.getGlobalOption(function (response) {
                try {
                    var currentTrackers = [];
                    if (response.success && response.data && response.data['bt-tracker']) {
                        currentTrackers = response.data['bt-tracker'].split(',').filter(function (tracker) {
                            return tracker.trim();
                        });
                    }

                    // Merge current trackers with new trackers, remove duplicates
                    var allTrackers = currentTrackers.concat(trackers);
                    var uniqueTrackers = [];
                    var seenTrackers = {};

                    for (var i = 0; i < allTrackers.length; i++) {
                        var tracker = allTrackers[i].trim();
                        if (tracker && !seenTrackers[tracker]) {
                            uniqueTrackers.push(tracker);
                            seenTrackers[tracker] = true;
                        }
                    }

                    // Update aria2 bt-tracker setting
                    aria2SettingService.setGlobalOption('bt-tracker', uniqueTrackers.join(','), function (response) {
                        if (response.success) {
                            deferred.resolve();
                        } else {
                            deferred.reject(new Error('Failed to update bt-tracker setting'));
                        }
                    });
                } catch (error) {
                    deferred.reject(error);
                }
            });

            return deferred.promise;
        };

        var scheduleNextUpdate = function () {
            var interval = ariaNgSettingService.getTrackerAutoUpdateInterval();
            var intervalMs = 0;

            switch (interval) {
                case '1d':
                    intervalMs = 24 * 60 * 60 * 1000; // 1 day
                    break;
                case '1w':
                    intervalMs = 7 * 24 * 60 * 60 * 1000; // 1 week
                    break;
                case '1m':
                    intervalMs = 30 * 24 * 60 * 60 * 1000; // 1 month
                    break;
                default:
                    return;
            }

            if (updateInterval) {
                $timeout.cancel(updateInterval);
            }

            updateInterval = $timeout(function () {
                updateTrackers();
            }, intervalMs);

            ariaNgLogService.info('[ariaNgTrackerService.scheduleNextUpdate] next update scheduled in', intervalMs, 'ms');
        };

        var updateTrackers = function () {
            if (isUpdating) {
                ariaNgLogService.warn('[ariaNgTrackerService.updateTrackers] update already in progress');
                return $q.reject(new Error('Update already in progress'));
            }

            var sources = ariaNgSettingService.getTrackerSources();
            if (!sources || sources.length === 0) {
                ariaNgLogService.warn('[ariaNgTrackerService.updateTrackers] no tracker sources configured');
                return $q.reject(new Error('No tracker sources configured'));
            }

            isUpdating = true;
            ariaNgLogService.info('[ariaNgTrackerService.updateTrackers] starting tracker update from', sources.length, 'sources');

            var promises = sources.map(function (source) {
                return fetchTrackersFromSource(source);
            });

            return $q.all(promises.map(function (promise) {
                return promise.catch(function (error) {
                    return []; // Return empty array for failed sources
                });
            })).then(function (results) {
                var allTrackers = [];
                for (var i = 0; i < results.length; i++) {
                    allTrackers = allTrackers.concat(results[i]);
                }

                if (allTrackers.length === 0) {
                    throw new Error('No trackers fetched from any source');
                }

                ariaNgLogService.info('[ariaNgTrackerService.updateTrackers] fetched total', allTrackers.length, 'trackers');

                return updateAria2Trackers(allTrackers);
            }).then(function () {
                // Update last update time
                ariaNgSettingService.setTrackerLastUpdateTime(new Date().getTime());
                ariaNgLogService.info('[ariaNgTrackerService.updateTrackers] tracker update completed successfully');

                // Schedule next update
                if (ariaNgSettingService.getTrackerAutoUpdate()) {
                    scheduleNextUpdate();
                }

                return true;
            }).catch(function (error) {
                ariaNgLogService.error('[ariaNgTrackerService.updateTrackers] tracker update failed:', error);
                throw error;
            }).finally(function () {
                isUpdating = false;
            });
        };

        var checkAndStartAutoUpdate = function () {
            if (!ariaNgSettingService.getTrackerAutoUpdate()) {
                if (updateInterval) {
                    $timeout.cancel(updateInterval);
                    updateInterval = null;
                }
                return;
            }

            var lastUpdateTime = ariaNgSettingService.getTrackerLastUpdateTime();
            var interval = ariaNgSettingService.getTrackerAutoUpdateInterval();
            var now = new Date().getTime();
            var shouldUpdate = false;
            var intervalMs = 0;

            switch (interval) {
                case '1d':
                    intervalMs = 24 * 60 * 60 * 1000;
                    break;
                case '1w':
                    intervalMs = 7 * 24 * 60 * 60 * 1000;
                    break;
                case '1m':
                    intervalMs = 30 * 24 * 60 * 60 * 1000;
                    break;
                default:
                    return;
            }

            if (!lastUpdateTime || (now - lastUpdateTime) >= intervalMs) {
                shouldUpdate = true;
            }

            if (shouldUpdate) {
                // Delay initial update to allow app to fully initialize
                $timeout(function () {
                    updateTrackers();
                }, 5000);
            } else {
                scheduleNextUpdate();
            }
        };

        return {
            updateTrackers: updateTrackers,
            checkAndStartAutoUpdate: checkAndStartAutoUpdate,
            isUpdating: function () {
                return isUpdating;
            }
        };
    }]);
}());
