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

approvals.loadApprovals = function(app) {
    debug('loadApprovals()');
    var approvalsDir = path.join(utils.getDynamicDir(app), 'approvals');
    var approvalsFile = path.join(approvalsDir, '_index.json');
    if (!fs.existsSync(approvalsFile))
        throw new Error('Internal Server Error - Approvals index not found.');
    return JSON.parse(fs.readFileSync(approvalsFile, 'utf8'));
};

approvals.saveApprovals = function(app, approvalInfos) {
    debug('saveApprovals()');
    debug(approvalInfos);
    var approvalsDir = path.join(utils.getDynamicDir(app), 'approvals');
    var approvalsFile = path.join(approvalsDir, '_index.json');
    fs.writeFileSync(approvalsFile, JSON.stringify(approvalInfos, null, 2), 'utf8');
};

approvals.getApprovals = function(app, res, loggedInUserId) {
    debug('getApprovals()');
    if (!loggedInUserId)
        return res.status(403).jsonp({ message: 'Not allowed' });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed' });
    if (!userInfo.admin && !userInfo.approver)
        return res.status(403).jsonp({ message: 'Not allowed' });

    var approvalInfos = approvals.loadApprovals(app);
    //if user is approver, only show approval requests for api with same group as approver
    approvalInfos = approvalInfos.filter(function(approval) {
      if(userInfo.admin) return true; //show all approvals for admin
      if(userInfo.approver && userInfo.groups){
        for(var i=0; i< userInfo.groups.length; i++){
          if(approval.api.requiredGroup && (userInfo.groups[i]==approval.api.requiredGroup)){
            return true;
          }
        }
      }
      return false;
    });
    res.json(approvalInfos);
};

module.exports = approvals;
