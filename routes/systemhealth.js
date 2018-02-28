'use strict';

var path = require('path');
var fs = require('fs');
var debug = require('debug')('portal-api:systemhealth');
var request = require('request');
var async = require('async');
var uuid = require('node-uuid');

// This looks really weird, but apparently the "request" library does not
// consider "Let's Encrypt" SSL certificates as trusted (yet), and thus it
// rejects connections to such end points. As we intend to use Let's Encrypt
// as a default Certificate Provider, this would render the System Health
// "Unhealthy" for "portal" and "kong" if we don't explicitly allow untrusted
// connections for these two end points.
var https = require('https');
var agentOptions = { rejectUnauthorized: false };
var portalAgent = new https.Agent(agentOptions);

var utils = require('./utils');
var users = require('./users');
var webhooks = require('./webhooks');

var systemhealth = function () { };

systemhealth._health = [{
    name: 'api',
    message: 'Initializing',
    uptime: 0,
    healthy: 2,
    pingUrl: 'http://portal-api:3001/ping',
    version: utils.getVersion(),
    gitBranch: '(uninitialized)',
    gitLastCommit: '(uninitialized)',
    buildDate: '(uninitialized)'
}];

systemhealth._startupSeconds = utils.getUtc();
systemhealth.checkHealth = function (app) {
    debug('checkHealth()');
    if (!webhooks.areHooksEnabled()) {
        debug('checkHealth() - Webhooks are disabled');
        return;
    }
    var glob = utils.loadGlobals(app);

    // - Listeners
    // - Portal
    // - Kong 

    // Use a correlation ID when calling
    const correlationId = uuid.v4();

    const h = [];
    async.parallel({
        portalPing: function (callback) {
            const portalUri = glob.network.portalUrl + '/ping';
            const req = { url: portalUri, headers: { 'Correlation-Id': correlationId } };
            request.get(req, function (err, apiResult, apiBody) {
                callback(null, makeHealthEntry('portal', portalUri, err, apiResult, apiBody));
            });
        },
        kongPing: function (callback) {
            const kongUri = glob.network.schema + '://' + glob.network.apiHost + '/ping-portal';
            const req = { url: kongUri, headers: { 'Correlation-Id': correlationId } };
            // We'll only inject the "insecure" agent if we really need it.
            if ("https" == glob.network.schema)
                req.agent = portalAgent;
            request.get(req, function (err, apiResult, apiBody) {
                callback(null, makeHealthEntry('kong', kongUri, err, apiResult, apiBody));
            });
        }
    }, function (err, results) {
        if (err) {
            // Uuuh. This is bad.
            h.push({
                name: 'api',
                message: err.message,
                error: JSON.stringify(err, null, 2),
                uptime: (utils.getUtc() - systemhealth._startupSeconds),
                healthy: 0,
                pingUrl: 'http://portal-api:3001/ping',
                version: utils.getVersion(),
                gitLastCommit: utils.getGitLastCommit(),
                gitBranch: utils.getGitBranch(),
                buildDate: utils.getBuildDate()
            });

            systemhealth._health = h;
        } else {

            h.push(results.portalPing);
            h.push(results.kongPing);

            // Check our webhook listeners
            var listeners = webhooks.loadListeners(app);
            async.map(listeners, function (listener, callback) {
                debug('checkHealth() - pinging ' + listener.id);
                request.get({
                    url: listener.url + 'ping',
                    headers: { 'Correlation-Id': correlationId }
                }, function (apiErr, apiResult, apiBody) {
                    var listenerHealth = makeHealthEntry(listener.id, listener.url + 'ping', apiErr, apiResult, apiBody);
                    callback(null, listenerHealth);
                });
            }, function (err, results) {
                debug('checkHealth() - pings are done');

                if (err) {
                    // Uuuh. This is bad.
                    h.push({
                        name: 'api',
                        message: err.message,
                        error: JSON.stringify(err, null, 2),
                        uptime: (utils.getUtc() - systemhealth._startupSeconds),
                        healthy: 0,
                        pingUrl: 'http://portal-api:3001/ping',
                        pendingEvents: -1,
                        version: utils.getVersion(),
                        gitLastCommit: utils.getGitLastCommit(),
                        gitBranch: utils.getGitBranch(),
                        buildDate: utils.getBuildDate()
                    });
                } else {
                    // We think we are healthy
                    h.push({
                        name: 'api',
                        message: 'Up and running',
                        uptime: (utils.getUtc() - systemhealth._startupSeconds),
                        healthy: 1,
                        pingUrl: 'http://portal-api:3001/ping',
                        pendingEvents: -1,
                        version: utils.getVersion(),
                        gitLastCommit: utils.getGitLastCommit(),
                        gitBranch: utils.getGitBranch(),
                        buildDate: utils.getBuildDate()
                    });

                    for (var i = 0; i < results.length; ++i) {
                        // Add pending events info
                        results[i].pendingEvents = webhooks.loadEvents(app, results[i].name).length;
                        h.push(results[i]);
                    }
                }

                systemhealth._health = h;
                debug(h);
            });
        }
    });
};

function makeHealthEntry(pingName, pingUrl, apiErr, apiResult, apiBody) {
    debug('makeHealthEntry()');
    if (apiErr) {
        return {
            name: pingName,
            message: apiErr.message,
            error: JSON.stringify(apiErr, null, 2),
            uptime: -1,
            healthy: false,
            pingUrl: pingUrl,
            pendingEvents: -1,
        };
    }
    if (200 != apiResult.statusCode) {
        var msg = 'Unexpected PING result: ' + apiResult.statusCode;
        var healthy = 0;
        var error;
        try {
            var jsonBody = utils.getJson(apiBody);
            if (jsonBody.hasOwnProperty('healthy'))
                healthy = jsonBody.healthy;
            if (jsonBody.hasOwnProperty('message'))
                msg = jsonBody.message;
            if (jsonBody.hasOwnProperty('error'))
                error = jsonBody.error;
        } catch (err) {
            debug('Couldn\'t parse JSON from body:');
            debug(apiBody);
            debug(err);
            // Deliberate
        }
        return {
            name: pingName,
            message: msg,
            error: error,
            uptime: -1,
            healthy: healthy,
            pingUrl: pingUrl,
            pendingEvents: -1,
        };
    }

    try {
        var pingResponse = utils.getJson(apiBody);
        pingResponse.name = pingName;
        pingResponse.pingUrl = pingUrl;
        pingResponse.pendingEvents = -1; // May be overwritten

        if (pingName === 'kong') {
            // These are from the portal, should not be returned
            if (pingResponse.version)
                delete pingResponse.version;
            if (pingResponse.gitBranch)
                delete pingResponse.gitBranch;
            if (pingResponse.gitLastCommit)
                delete pingResponse.gitLastCommit;
            if (pingResponse.buildDate)
                delete pingResponse.buildDate;
        }

        return pingResponse;
    } catch (err) {
        debug('pingResponse: Couldn\'t extract health info from body:');
        debug(apiBody);
        debug(err);
        // Deliberate

        return {
            name: pingName,
            message: 'Could not parse pingResponse: ' + err.message,
            error: err,
            uptime: -1,
            healthy: 0,
            pingUrl: pingUrl,
            pendingEvents: -1,
        };
    }
}

systemhealth.getSystemHealthInternal = function (app) {
    return systemhealth._health;
};

systemhealth.getSystemHealth = function (app, res, loggedInUserId) {
    debug('getSystemHealth()');
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo ||
        !userInfo.admin)
        return res.status(403).jsonp({ message: 'Not allowed. Only Admins may do this.' });
    return res.json(systemhealth._health);
};

module.exports = systemhealth;
