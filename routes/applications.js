'use strict';

var fs = require('fs');
var path = require('path');
var debug = require('debug')('portal-api:applications');
var utils = require('./utils');
var users = require('./users');
var subscriptions = require('./subscriptions');
var approvals = require('./approvals');
var ownerRoles = require('./ownerRoles');
var webhooks = require('./webhooks');

var applications = require('express').Router();

// ===== ENDPOINTS =====

applications.get('/', function (req, res, next) {
    applications.getApplications(req.app, res, req.apiUserId);
});

applications.post('/', function (req, res, next) {
    applications.createApplication(req.app, res, req.apiUserId, req.body);
});

applications.get('/roles', function (req, res, next) {
    applications.getRoles(req.app, res);
});

applications.get('/:appId', function (req, res, next) {
    applications.getApplication(req.app, res, req.apiUserId, req.params.appId);
});

applications.patch('/:appId', function (req, res, next) {
    applications.patchApplication(req.app, res, req.apiUserId, req.params.appId, req.body);
});

applications.delete('/:appId', function (req, res, next) {
    applications.deleteApplication(req.app, res, req.apiUserId, req.params.appId);
});

applications.post('/:appId/owners', function (req, res, next) {
    applications.addOwner(req.app, res, req.apiUserId, req.params.appId, req.body);
});

applications.delete('/:appId/owners', function (req, res, next) {
    applications.deleteOwner(req.app, res, req.apiUserId, req.params.appId, req.query.userEmail);
});

// ===== SUBSCRIPTIONS ENDPOINTS ======

applications.get('/:appId/subscriptions', function (req, res, next) {
    subscriptions.getSubscriptions(req.app, res, applications, req.apiUserId, req.params.appId);
});

applications.post('/:appId/subscriptions', function (req, res, next) {
    subscriptions.addSubscription(req.app, res, applications, req.apiUserId, req.params.appId, req.body);
});

applications.get('/:appId/subscriptions/:apiId', function (req, res, next) {
    subscriptions.getSubscription(req.app, res, applications, req.apiUserId, req.params.appId, req.params.apiId);
});

applications.delete('/:appId/subscriptions/:apiId', function (req, res, next) {
    subscriptions.deleteSubscription(req.app, res, applications, req.apiUserId, req.params.appId, req.params.apiId);
});

applications.patch('/:appId/subscriptions/:apiId', function (req, res, next) {
    subscriptions.patchSubscription(req.app, res, applications, req.apiUserId, req.params.appId, req.params.apiId, req.body);
});

// ===== SPECIAL ENDPOINT, THIS IS REGISTERED IN app.js =====

// '/subscriptions/:clientId'
applications.getSubscriptionByClientId = function (req, res) {
    subscriptions.getSubscriptionByClientId(req.app, res, applications, req.apiUserId, req.params.clientId);
};

// ===== IMPLEMENTATION =====

applications.loadAppsIndex = function (app) {
    debug('loadAppsIndex()');
    var appsDir = utils.getAppsDir(app);
    var appIndexFileName = path.join(appsDir, '_index.json');
    return JSON.parse(fs.readFileSync(appIndexFileName, 'utf8'));
};

applications.saveAppsIndex = function (app, appsIndex) {
    debug('saveAppsIndex()');
    var appsDir = utils.getAppsDir(app);
    var appIndexFileName = path.join(appsDir, '_index.json');
    fs.writeFileSync(appIndexFileName, JSON.stringify(appsIndex, null, 2), 'utf8');
};

applications.loadApplication = function (app, appId) {
    debug('loadApplication(): ' + appId);
    var appsDir = utils.getAppsDir(app);
    var appsFileName = path.join(appsDir, appId + '.json');
    if (!fs.existsSync(appsFileName))
        return null;
    //throw "applications.loadApplication - Application not found: " + appId;
    return JSON.parse(fs.readFileSync(appsFileName, 'utf8'));
};

applications.saveApplication = function (app, appInfo, userId) {
    debug('saveApplication()');
    debug(appInfo);
    var appsDir = utils.getAppsDir(app);
    var appsFileName = path.join(appsDir, appInfo.id + '.json');
    appInfo.changedBy = userId;
    appInfo.changedDate = utils.getUtc();
    fs.writeFileSync(appsFileName, JSON.stringify(appInfo, null, 2), 'utf8');
};

var accessFlags = {
    NONE: 0,
    ADMIN: 1,
    COLLABORATE: 2,
    READ: 4
};

applications.isValidRedirectUri = function (redirectUri) {
    return redirectUri &&
        (redirectUri.indexOf('#') < 0) &&
        (
            (redirectUri.startsWith('https://') && (redirectUri !== 'https://')) ||
            (redirectUri.startsWith('http://localhost')) ||
            (redirectUri.startsWith('http://127.0.0.1')) ||
            (redirectUri.startsWith('http://portal.local'))
        );
};

applications.getAllowedAccess = function (app, appInfo, userInfo) {
    debug('getAllowedAccess()');
    if (userInfo.admin)
        return accessFlags.ADMIN;
    // Check roles
    for (var i = 0; i < appInfo.owners.length; ++i) {
        var owner = appInfo.owners[i];
        if (owner.userId != userInfo.id)
            continue;

        if (ownerRoles.OWNER == owner.role)
            return accessFlags.ADMIN;
        else if (ownerRoles.COLLABORATOR == owner.role)
            return accessFlags.COLLABORATOR;
        else if (ownerRoles.READER == owner.role)
            return accessFlags.READER;
    }

    return accessFlags.NONE;
};

applications.getApplications = function (app, res, loggedInUserId) {
    debug('getApplications()');
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed.' });
    if (!userInfo.admin && !userInfo.approver)
        return res.status(403).jsonp({ message: 'Not allowed. This is admin land.' });

    var appsIndex = applications.loadAppsIndex(app);
    res.json(appsIndex);
};

applications.getApplication = function (app, res, loggedInUserId, appId) {
    debug('getApplication(): ' + appId);
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });

    var access = applications.getAllowedAccess(app, appInfo, userInfo);

    if (access == accessFlags.NONE)
        return res.status(403).jsonp({ message: 'Not allowed.' });
    if (access == accessFlags.ADMIN) {
        // Add some more links if you're Admin
        appInfo._links.addOwner = { href: '/applications/' + appId + '/owners', method: 'POST' };
        // If we have more than one owner, we may allow deleting
        if (appInfo.owners.length > 1) {
            // More than one with role "owner"?
            var ownerCount = 0;
            for (let i = 0; i < appInfo.owners.length; ++i) {
                if (ownerRoles.OWNER == appInfo.owners[i].role)
                    ownerCount++;
            }
            for (let i = 0; i < appInfo.owners.length; ++i) {
                if (appInfo.owners[i].role != ownerRoles.OWNER ||
                    ownerCount > 1) {
                    if (!appInfo.owners[i]._links)
                        appInfo.owners[i]._links = {};
                    appInfo.owners[i]._links.deleteOwner = {
                        href: '/applications/' + appId + '/owners', method: 'DELETE'
                    };
                }
            }
        }
        appInfo._links.addSubscription = { href: '/applications/' + appId + '/subscriptions', method: 'POST' };
        appInfo._links.deleteApplication = { href: '/applications/' + appId, method: 'DELETE' };
        appInfo._links.patchApplication = { href: '/applications/' + appId, method: 'PATCH' };
    }
    res.json(appInfo);
};


applications.createApplication = function (app, res, loggedInUserId, appCreateInfo) {
    debug('createApplication(): loggedInUserId: ' + loggedInUserId);
    debug(appCreateInfo);
    utils.withLockedAppsIndex(app, res, function () {
        var appsIndex = applications.loadAppsIndex(app);
        var appId = appCreateInfo.id.trim();
        var redirectUri = appCreateInfo.redirectUri;
        // Load user information
        var userInfo = users.loadUser(app, loggedInUserId);
        if (!userInfo)
            return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });
        if (!userInfo.validated)
            return res.status(403).jsonp({ message: 'Not allowed. Email address not validated.' });
        if (redirectUri && !applications.isValidRedirectUri(redirectUri))
            return res.status(400).jsonp({ message: 'redirectUri must be a https URI' });
        if (!appCreateInfo.name || appCreateInfo.name.length < 1)
            return res.status(400).jsonp({ message: 'Friendly name of application cannot be empty.' });

        utils.withLockedUser(app, res, loggedInUserId, function () {
            var regex = /^[a-zA-Z0-9\-_]+$/;

            if (!regex.test(appId))
                return res.status(400).jsonp({ message: 'Invalid application ID, allowed chars are: a-z, A-Z, -, _' });
            if (appId.length < 4 || appId.length > 50)
                return res.status(400).jsonp({ message: 'Invalid application ID, must have at least 4, max 50 characters.' });

            // Check for dupes
            for (var i = 0; i < appsIndex.length; ++i) {
                var appInfo = appsIndex[i];
                if (appInfo.id == appId)
                    return res.status(409).jsonp({ message: 'Application ID "' + appId + '" already exists.' });
            }

            // Now we can add the application
            var newApp = {
                id: appId,
                name: appCreateInfo.name.substring(0, 128),
                description: appCreateInfo.description.substring(0, 128),
                redirectUri: appCreateInfo.redirectUri,
                owners: [
                    {
                        userId: userInfo.id,
                        email: userInfo.email,
                        role: ownerRoles.OWNER,
                        _links: {
                            user: { href: '/users/' + userInfo.id }
                        }
                    }
                ],
                _links: {
                    self: { href: '/applications/' + appId }
                }
            };

            // Push new application to user
            userInfo.applications.push({
                id: appId,
                _links: {
                    application: { href: '/applications/' + appId }
                }
            });

            // Push to index
            appsIndex.push({ id: appId });
            // Persist application
            applications.saveApplication(app, newApp, loggedInUserId);
            // Persist application subscriptions (empty)
            subscriptions.saveSubscriptions(app, appId, []);
            // Persist index
            applications.saveAppsIndex(app, appsIndex);
            // Persist user
            delete userInfo.name;
            users.saveUser(app, userInfo, loggedInUserId);

            res.status(201).json(newApp);

            // Save to webhooks
            webhooks.logEvent(app, {
                action: webhooks.ACTION_ADD,
                entity: webhooks.ENTITY_APPLICATION,
                data: {
                    applicationId: appId,
                    userId: userInfo.id
                }
            });
        });
    });
};

applications.patchApplication = function (app, res, loggedInUserId, appId, appPatchInfo) {
    debug('patchApplication(): ' + appId);
    debug(appPatchInfo);

    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var access = applications.getAllowedAccess(app, appInfo, userInfo);
    if (!((accessFlags.ADMIN & access) || (accessFlags.COLLABORATOR & access)))
        return res.status(403).jsonp({ message: 'Not allowed, not sufficient rights to application.' });
    if (appId != appPatchInfo.id)
        return res.status(400).jsonp({ message: 'Changing application ID is not allowed. Sorry.' });
    const redirectUri = appPatchInfo.redirectUri;
    if (redirectUri && !applications.isValidRedirectUri(redirectUri))
        return res.status(400).jsonp({ message: 'redirectUri must be a https URI' });

    utils.withLockedApp(app, res, appId, function () {
        // Update app
        if (appPatchInfo.name)
            appInfo.name = appPatchInfo.name.substring(0, 128);
        if (appPatchInfo.description)
            appInfo.description = appPatchInfo.description.substring(0, 128);
            
        if (redirectUri)
            appInfo.redirectUri = redirectUri;

        // And persist
        applications.saveApplication(app, appInfo, loggedInUserId);

        res.json(appInfo);

        // Fire off webhook
        webhooks.logEvent(app, {
            action: webhooks.ACTION_UPDATE,
            entity: webhooks.ENTITY_APPLICATION,
            data: {
                applicationId: appId,
                userId: userInfo.id
            }
        });
    });
};

applications.deleteApplication = function (app, res, loggedInUserId, appId) {
    debug('deleteApplication(): ' + appId);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var access = applications.getAllowedAccess(app, appInfo, userInfo);

    // Only let Owners and Admins do that
    if (!(accessFlags.ADMIN & access))
        return res.status(403).jsonp({ message: 'Not allowed. Only Owners and Admins can delete an Application.' });

    var ownerIdList = [];
    for (var i = 0; i < appInfo.owners.length; ++i)
        ownerIdList.push(appInfo.owners[i].userId);

    utils.withLockedAppsIndex(app, res, function () {
        utils.withLockedApp(app, res, appId, function () {
            utils.withLockedUserList(app, res, ownerIdList, function () {
                utils.withLockedApprovals(app, res, function () {
                    var appsIndex = applications.loadAppsIndex(app);
                    var index = -1;
                    for (let i = 0; i < appsIndex.length; ++i) {
                        if (appId == appsIndex[i].id) {
                            index = i;
                            break;
                        }
                    }

                    if (index < 0)
                        throw "Application with id " + appId + " was not found in index.";
                    appsIndex.splice(index, 1);

                    for (let i = 0; i < ownerIdList.length; ++i) {
                        var ownerInfo = users.loadUser(app, ownerIdList[i]);
                        if (!ownerInfo)
                            throw "In DELETE applications: Could not find owner " + ownerIdList[i];
                        // Remove application from applications list
                        var found = true;
                        while (found) {
                            let index = -1;
                            for (let j = 0; j < ownerInfo.applications.length; ++j) {
                                if (ownerInfo.applications[j].id == appId) {
                                    index = j;
                                    break;
                                }
                            }
                            if (index >= 0)
                                ownerInfo.applications.splice(index, 1);
                            else
                                found = false;
                        }
                        try {
                            delete ownerInfo.name;
                            users.saveUser(app, ownerInfo, loggedInUserId);
                        } catch (err) {
                            debug(err);
                            console.error('Caught exception saving user ' + ownerInfo.id);
                            console.error(err);
                        }
                    }

                    // Now persist the index
                    applications.saveAppsIndex(app, appsIndex);

                    // And delete the application
                    var appsDir = utils.getAppsDir(app);
                    var appsFileName = path.join(appsDir, appId + '.json');

                    if (fs.existsSync(appsFileName))
                        fs.unlinkSync(appsFileName);

                    // And its subcriptions
                    // Delete all subscriptions from the subscription indexes (if applicable)
                    const appSubs = subscriptions.loadSubscriptions(app, appId);
                    for (let i = 0; i < appSubs.length; ++i) {
                        const appSub = appSubs[i];
                        if (appSub.clientId)
                            subscriptions.deleteSubscriptionIndexEntry(app, appSub.clientId);
                        subscriptions.deleteSubscriptionApiIndexEntry(app, appSub);
                    }
                    // And now delete the subscription file
                    var subsFileName = path.join(appsDir, appId + '.subs.json');
                    if (fs.existsSync(subsFileName))
                        fs.unlinkSync(subsFileName);

                    // Now we'll try to clean up the approvals, if needed
                    try {
                        var approvalInfos = approvals.loadApprovals(app);

                        var notReady = true;
                        var foundApproval = false;
                        while (notReady) {
                            notReady = false;
                            var approvalIndex = -1;
                            for (let i = 0; i < approvalInfos.length; ++i) {
                                if (appId == approvalInfos[i].application.id) {
                                    approvalIndex = i;
                                    break;
                                }
                            }
                            if (approvalIndex >= 0) {
                                foundApproval = true;
                                notReady = true;
                                approvalInfos.splice(approvalIndex, 1);
                            }
                        }
                        if (foundApproval) {
                            // Persist the approvals again
                            approvals.saveApprovals(app, approvalInfos);
                        }
                    } catch (err) {
                        debug(err);
                        console.error(err);
                    }

                    res.status(204).jsonp({ message: 'Deleted.' });

                    webhooks.logEvent(app, {
                        action: webhooks.ACTION_DELETE,
                        entity: webhooks.ENTITY_APPLICATION,
                        data: {
                            applicationId: appId,
                            userId: userInfo.id,
                            subscriptions: appSubs
                        }
                    });
                });
            });
        });
    });
};

applications.addOwner = function (app, res, loggedInUserId, appId, ownerCreateInfo) {
    debug('addOwner()');
    debug(ownerCreateInfo);
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });

    var access = applications.getAllowedAccess(app, appInfo, userInfo);
    // We want Admin Access for this
    if (!(accessFlags.ADMIN & access))
        return res.status(403).jsonp({ message: 'Not allowed. Only Owners and Admins may add owners.' });

    var email = ownerCreateInfo.email;
    var role = ownerCreateInfo.role;

    var userToAdd = users.loadUserByEmail(app, email);
    if (!userToAdd)
        return res.status(400).jsonp({ message: 'Bad request. User with email "' + email + '" not found.' });
    if (!(ownerRoles.OWNER == role ||
        ownerRoles.COLLABORATOR == role ||
        ownerRoles.READER == role))
        return res.status(400).jsonp({ message: 'Bad request. Unknown role "' + role + '".' });

    // Does this user already know this application?
    for (let i = 0; i < userToAdd.applications.length; ++i) {
        if (userToAdd.applications[i].id == appId)
            return res.status(409).jsonp({ message: 'Bad request. Owner is already registered for this application.' });
    }

    utils.withLockedApp(app, res, appId, function () {
        utils.withLockedUser(app, res, userToAdd.id, function () {
            userToAdd.applications.push({
                id: appId,
                _links: {
                    application: { href: '/applications/' + appId }
                }
            });

            appInfo.owners.push({
                userId: userToAdd.id,
                email: userToAdd.email,
                role: role,
                _links: {
                    user: { href: '/users/' + userToAdd.id }
                }
            });

            // Persist application
            applications.saveApplication(app, appInfo, loggedInUserId);

            // Persist user
            users.saveUser(app, userToAdd, loggedInUserId);

            // Return appInfo
            res.status(201).json(appInfo);

            // Webhook
            webhooks.logEvent(app, {
                action: webhooks.ACTION_ADD,
                entity: webhooks.ENTITY_OWNER,
                data: {
                    applicationId: appId,
                    userId: loggedInUserId,
                    addedUserId: userToAdd.id,
                    role: role
                }
            });
        });
    });
};

applications.deleteOwner = function (app, res, loggedInUserId, appId, userEmail) {
    debug('deleteOwner(): ' + appId + ', email: ' + userEmail);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var access = applications.getAllowedAccess(app, appInfo, userInfo);
    // We want Admin Access for this
    if (!(accessFlags.ADMIN & access))
        return res.status(403).jsonp({ message: 'Not allowed. Only Owners and Admins may delete owners.' });

    var userToDelete = users.loadUserByEmail(app, userEmail);
    if (!userToDelete)
        return res.status(400).jsonp({ messafe: 'Bad request. User with email "' + userEmail + '" not found."' });
    // Does this user know this application?
    var index = -1;
    for (var i = 0; i < userToDelete.applications.length; ++i) {
        if (userToDelete.applications[i].id == appId) {
            // Yes, found it
            index = i;
            break;
        }
    }

    // In case we don't have this user for this application
    if (index < 0) {
        return res.json(appInfo);
    }

    // Is it the last owner?
    if (appInfo.owners.length == 1)
        return res.status(409).jsonp({ message: 'Conflict. Can not delete last owner of application.' });

    // Do da locking
    utils.withLockedApp(app, res, appId, function () {
        utils.withLockedUser(app, res, userToDelete.id, function () {
            var found = true;
            while (found) {
                let index = -1;
                for (let i = 0; i < appInfo.owners.length; ++i) {
                    if (appInfo.owners[i].userId == userToDelete.id) {
                        index = i;
                        break;
                    }
                }
                if (index >= 0)
                    appInfo.owners.splice(index, 1);
                else
                    found = false;
            }
            found = true;
            while (found) {
                let index = -1;
                for (let i = 0; i < userToDelete.applications.length; ++i) {
                    if (userToDelete.applications[i].id == appId) {
                        index = i;
                        break;
                    }
                }
                if (index >= 0)
                    userToDelete.applications.splice(index, 1);
                else
                    found = false;
            }

            // Persist user
            users.saveUser(app, userToDelete, loggedInUserId);

            // Persist application
            applications.saveApplication(app, appInfo, loggedInUserId);

            res.json(appInfo);

            // Webhook
            webhooks.logEvent(app, {
                action: webhooks.ACTION_DELETE,
                entity: webhooks.ENTITY_OWNER,
                data: {
                    applicationId: appId,
                    userId: loggedInUserId,
                    deletedUserId: userToDelete.id
                }
            });
        });
    });
};

applications.getRoles = function (app, res) {
    debug('getRoles()');
    return res.json([
        {
            role: ownerRoles.OWNER,
            desc: 'Administrator, may change all aspects of the Application'
        },
        {
            role: ownerRoles.COLLABORATOR,
            desc: 'Collaborator, may subscribe and unsubscribe to APIs for the application, but may not add or delete owners.'
        },
        {
            role: ownerRoles.READER,
            desc: 'Reader, may see all aspects of an application, but not change anything.'
        }
    ]);
};

module.exports = applications;
