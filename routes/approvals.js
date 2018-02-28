'use strict';

var fs = require('fs');
var path = require('path');
var debug = require('debug')('portal-api:approvals');
var utils = require('./utils');
var users = require('./users');

var approvals = require('express').Router();

// ===== ENDPOINTS =====

approvals.get('/', function (req, res, next) {
    approvals.getApprovals(req.app, res, req.apiUserId);
});

// ===== IMPLEMENTATION =====

approvals.loadApprovals = function (app) {
    debug('loadApprovals()');
    var approvalsDir = path.join(utils.getDynamicDir(app), 'approvals');
    var approvalsFile = path.join(approvalsDir, '_index.json');
    if (!fs.existsSync(approvalsFile))
        throw new Error('Internal Server Error - Approvals index not found.');
    return JSON.parse(fs.readFileSync(approvalsFile, 'utf8'));
};

approvals.saveApprovals = function (app, approvalInfos) {
    debug('saveApprovals()');
    debug(approvalInfos);
    var approvalsDir = path.join(utils.getDynamicDir(app), 'approvals');
    var approvalsFile = path.join(approvalsDir, '_index.json');
    fs.writeFileSync(approvalsFile, JSON.stringify(approvalInfos, null, 2), 'utf8');
};

approvals.getApprovals = function (app, res, loggedInUserId) {
    debug('getApprovals()');
    if (!loggedInUserId)
        return res.status(403).jsonp({ message: 'Not allowed' });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed' });
    if (!userInfo.admin && !userInfo.approver)
        return res.status(403).jsonp({ message: 'Not allowed' });

    var approvalInfos = approvals.loadApprovals(app);
    var groupsJson = utils.loadGroups(app);
    var groups = groupsJson.groups;

    // Assemble a user's groups to check for approval roles
    // and correct groups. If the user is not admin but approver,
    // the requiredGroup needs to be present in this user's list
    // of groups.
    var userGroups = {};
    if (userInfo.groups) {
        for (var i = 0; i < userInfo.groups.length; i++) {
            userGroups[userInfo.groups[i]] = true;
        }
        // This is probably not strictly necessary, as the alt_ids
        // are mapped to wicked groups at login anyway, but it doesn't
        // hurt either.
        for (var i = 0; i < groups.length; i++) {
            if (userGroups.hasOwnProperty(groups[i].id)) {
                var alt_ids = groups[i].alt_ids;
                if (alt_ids) {
                    for (var j = 0; j < alt_ids.length; j++) {
                        userGroups[alt_ids[j]] = true;
                    }
                }
            }
        }
    }

    approvalInfos = approvalInfos.filter(function (approval) {
        if (userInfo.admin)
            return true; // Show all approvals for admin
        if (!approval.api.requiredGroup)
            return false; // API does not require a group; only admins can approve of public APIs.

        // If group id or alt_id of approver's group matches with requiredGroup of an API, return happy
        return (!!userGroups[approval.api.requiredGroup]);
    });
    res.json(approvalInfos);
};

module.exports = approvals;
