'use strict';

var fs = require('fs');
var path = require('path');
var debug = require('debug')('portal-api:subscriptions');
var utils = require('./utils');
var users = require('./users');
var ownerRoles = require('./ownerRoles');
var approvals = require('./approvals');
var webhooks = require('./webhooks');

var subscriptions = function () { };

subscriptions.getSubsDir = function (app) {
    return path.join(utils.getDynamicDir(app), 'subscriptions');
};

subscriptions.getSubsIndexDir = function (app) {
    return path.join(utils.getDynamicDir(app), 'subscription_index');
};

subscriptions.getSubsApiIndexDir = function (app) {
    return path.join(utils.getDynamicDir(app), 'subscription_api_index');
};

subscriptions.loadSubscriptions = function (app, appId) {
    debug('loadSubscriptions(): ' + appId);
    var subsDir = subscriptions.getSubsDir(app);
    var subsFileName = path.join(subsDir, appId + '.subs.json');
    var subs = JSON.parse(fs.readFileSync(subsFileName, 'utf8'));
    for (var i = 0; i < subs.length; ++i) {
        var sub = subs[i];
        if (sub.apikey)
            sub.apikey = utils.apiDecrypt(app, sub.apikey);
        if (sub.clientId)
            sub.clientId = utils.apiDecrypt(app, sub.clientId);
        if (sub.clientSecret)
            sub.clientSecret = utils.apiDecrypt(app, sub.clientSecret);
    }
    return subs;
};

subscriptions.saveSubscriptions = function (app, appId, subsIndex) {
    debug('saveSubscriptions(): ' + appId);
    debug(subsIndex);

    var subsDir = subscriptions.getSubsDir(app);
    var subsFileName = path.join(subsDir, appId + '.subs.json');
    for (var i = 0; i < subsIndex.length; ++i) {
        var sub = subsIndex[i];
        if (sub.apikey)
            sub.apikey = utils.apiEncrypt(app, sub.apikey);
        if (sub.clientId)
            sub.clientId = utils.apiEncrypt(app, sub.clientId);
        if (sub.clientSecret)
            sub.clientSecret = utils.apiEncrypt(app, sub.clientSecret);
    }
    fs.writeFileSync(subsFileName, JSON.stringify(subsIndex, null, 2), 'utf8');
};

subscriptions.loadSubscriptionIndexEntry = function (app, clientId) {
    debug('loadSubscriptionIndexEntry()');
    const indexDir = subscriptions.getSubsIndexDir(app);
    const fileName = path.join(indexDir, clientId + '.json');
    debug('Trying to load ' + fileName);
    if (!fs.existsSync(fileName))
        return null;
    return JSON.parse(fs.readFileSync(fileName, 'utf8'));
};

subscriptions.saveSubscriptionIndexEntry = function (app, clientId, subsInfo) {
    debug('saveSubscriptionIndexEntry()');
    const indexDir = subscriptions.getSubsIndexDir(app);
    const fileName = path.join(indexDir, clientId + '.json');
    const data = {
        application: subsInfo.application,
        api: subsInfo.api
    };
    debug('Writing to ' + fileName);
    debug(data);
    fs.writeFileSync(fileName, JSON.stringify(data, null, 2), 'utf8');
};

subscriptions.deleteSubscriptionIndexEntry = function (app, clientId) {
    debug('loadSubscriptionIndexEntry()');
    const indexDir = subscriptions.getSubsIndexDir(app);
    const fileName = path.join(indexDir, clientId + '.json');
    if (fs.existsSync(fileName))
        fs.unlinkSync(fileName);
};

subscriptions.loadSubscriptionApiIndex = function (app, apiId) {
    debug('loadSubscriptionApiIndex(): ' + apiId);
    const indexDir = subscriptions.getSubsApiIndexDir(app);
    const fileName = path.join(indexDir, apiId + '.json');
    if (!fs.existsSync(fileName))
        return null;
    return JSON.parse(fs.readFileSync(fileName, 'utf8'));
};

subscriptions.saveSubscriptionApiIndex = function (app, apiId, apiIndex) {
    debug('saveSubscriptionApiIndex(): ' + apiId);
    const indexDir = subscriptions.getSubsApiIndexDir(app);
    const fileName = path.join(indexDir, apiId + '.json');
    return fs.writeFileSync(fileName, JSON.stringify(apiIndex, null, 2), 'utf8');
};

subscriptions.addSubscriptionApiIndexEntry = function (app, subsInfo) {
    debug('addSubscriptionApiIndexEntry(): ' + subsInfo.application + ', plan: ' + subsInfo.plan);
    const appId = subsInfo.application;
    const planId = subsInfo.plan;
    const apiId = subsInfo.api;
    let apiIndex = subscriptions.loadSubscriptionApiIndex(app, apiId);
    if (!apiIndex) {
        console.error('*** addSubscriptionApiIndexEntry: Could not find index; recreating.');
        apiIndex = [];
    }

    const indexEntry = apiIndex.find(ie => ie.application === appId);
    if (indexEntry) {
        console.error('*** addSubscriptionApiIndexEntry() was called with an application which already has a subscription.');
        // This is strange, and shouldn't happen.
        indexEntry.plan = planId;
    } else {
        apiIndex.push({
            application: appId,
            plan: planId
        });
    }
    subscriptions.saveSubscriptionApiIndex(app, apiId, apiIndex);
};

subscriptions.deleteSubscriptionApiIndexEntry = function (app, subsInfo) {
    debug('deleteSubscriptionApiIndexEntry(): ' + subsInfo.api + ', application: ' + subsInfo.application);
    const apiId = subsInfo.api;
    const appId = subsInfo.application;

    let apiIndex = subscriptions.loadSubscriptionApiIndex(app, apiId);
    if (!apiIndex) {
        console.error('*** deleteSubscriptionApiIndexEntry: Could not find index; recreating.');
        apiIndex = [];
    }
    let indexOfApp = -1;
    for (let i = 0; i < apiIndex.length; ++i) {
        const entry = apiIndex[i];
        if (entry.application == appId) {
            indexOfApp = i;
            break;
        }
    }
    if (indexOfApp >= 0) {
        // remove from index
        // debug(apiIndex);
        apiIndex.splice(indexOfApp, 1);
        // debug(apiIndex);
        subscriptions.saveSubscriptionApiIndex(app, apiId, apiIndex);
    } else {
        console.error('*** deleteSubscriptionApiIndexEntry called to remove entry for ' + appId + ' which is not present for API ' + apiId);
    }
};

subscriptions.getOwnerRole = function (appInfo, userInfo) {
    debug('getOwnerRole()');
    for (var i = 0; i < appInfo.owners.length; ++i) {
        if (appInfo.owners[i].userId == userInfo.id)
            return appInfo.owners[i].role;
    }
    // Unknown
    return null;
};

subscriptions.getSubscriptions = function (app, res, applications, loggedInUserId, appId) {
    debug('getSubscriptions(): ' + appId);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var isAllowed = false;
    var adminOrCollab = false;
    if (userInfo.admin) {
        isAllowed = true;
        adminOrCollab = true;
    }
    if (!isAllowed) {
        // Check for App rights
        var access = subscriptions.getOwnerRole(appInfo, userInfo);
        if (access) // Any role will do for GET
            isAllowed = true;
        if (ownerRoles.OWNER == access ||
            ownerRoles.COLLABORATOR == access)
            adminOrCollab = true;
    }

    if (!isAllowed)
        return res.status(403).jsonp({ message: 'Not allowed. User does not own application.' });
    var subs = subscriptions.loadSubscriptions(app, appId);
    // Add some links if admin or collaborator
    if (adminOrCollab) {
        for (var i = 0; i < subs.length; ++i)
            subs[i]._links.deleteSubscription = {
                href: '/applications/' + appId + '/subscriptions/' + subs[i].api,
                method: 'DELETE'
            };
    }
    return res.json(subs);
};

subscriptions.addSubscription = function (app, res, applications, loggedInUserId, appId, subsCreateInfo) {
    debug('addSubscription(): ' + appId);
    debug(subsCreateInfo);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });
    if (!userInfo.validated)
        return res.status(403).jsonp({ message: 'Not allowed. Email address not validated.' });

    var isAllowed = false;
    var isAdmin = false;
    if (userInfo.admin) {
        isAllowed = true;
        isAdmin = true;
    }
    if (!isAllowed) {
        // Check for App rights
        var access = subscriptions.getOwnerRole(appInfo, userInfo);
        // OWNERs and COLLABORATORs may do this.
        if (access &&
            ((access == ownerRoles.OWNER) ||
                (access == ownerRoles.COLLABORATOR)))
            isAllowed = true;
    }

    if (!isAllowed)
        return res.status(403).jsonp({ message: 'Not allowed. Only owners and collaborators may add a subscription.' });

    if (appId != subsCreateInfo.application)
        return res.status(400).jsonp({ message: 'Bad request. App ID in body must match App ID in path.' });

    debug('Adding Subscription allowed.');

    var apis = utils.loadApis(app);
    // Valid api name?
    var apiIndex = -1;
    for (let i = 0; i < apis.apis.length; ++i) {
        if (apis.apis[i].id == subsCreateInfo.api) {
            apiIndex = i;
            break;
        }
    }
    if (apiIndex < 0)
        return res.status(400).jsonp({ message: 'Bad request. Unknown API "' + subsCreateInfo.api + '".' });

    // API deprecated?
    var selectedApi = apis.apis[apiIndex];
    if (selectedApi.deprecated)
        return res.status(400).jsonp({ message: 'API is deprecated. Subscribing not possible.' });

    // Valid plan?
    var foundPlan = false;
    for (let i = 0; i < selectedApi.plans.length; ++i) {
        if (selectedApi.plans[i] == subsCreateInfo.plan) {
            foundPlan = true;
            break;
        }
    }
    if (!foundPlan)
        return res.status(400).jsonp({ message: 'Bad request. Invalid plan "' + subsCreateInfo.plan + '".' });

    debug('Subscription plan and API known.');

    var apiPlans = utils.loadPlans(app).plans;
    var apiPlanIndex = -1;
    for (let i = 0; i < apiPlans.length; ++i) {
        if (apiPlans[i].id == subsCreateInfo.plan) {
            apiPlanIndex = i;
            break;
        }
    }
    if (apiPlanIndex < 0)
        return res.status(500).jsonp({ message: 'Inconsistent API/Plan data. Plan not found: ' + subsCreateInfo.plan });
    var apiPlan = apiPlans[apiPlanIndex];

    // Required group? Or Admin, they may also.
    if (selectedApi.requiredGroup) {
        // If the user is admin, hasUserGroup will always return true
        let hasGroup = users.hasUserGroup(app, userInfo, selectedApi.requiredGroup);
        if (!hasGroup)
            return res.status(403).jsonp({ message: 'Not allowed. User does not have access to the API.' });
    }

    // Now check required group for the selected plan
    if (apiPlan.requiredGroup) {
        // If the user is admin, hasUserGroup will always return true
        let hasGroup = users.hasUserGroup(app, userInfo, apiPlan.requiredGroup);
        if (!hasGroup)
            return res.status(403).jsonp({ message: 'Not allowed. User does not have access to the API Plan.' });
    }

    // Is it an oauth2 implicit/authorization code API? If so, the app needs a redirectUri
    if (selectedApi.auth === 'oauth2') {
        // In case the API only has implicit flow or authorization code grant flow,
        // the application NEEDS a redirect URI (otherwise not).
        if (!appInfo.redirectUri &&
            selectedApi.settings &&
            !selectedApi.settings.enable_client_credentials &&
            !selectedApi.settings.enable_password_grant)
            return res.status(400).jsonp({ message: 'Application does not have a redirectUri' });
    }

    debug('All set to add subscription.');

    // It might not be necessary to actually lock the approvals,
    // but this makes the code easier to maintain.
    utils.withLockedSubscriptions(app, res, appId, function () {
        utils.withLockedApprovals(app, res, function () {

            var appSubs = subscriptions.loadSubscriptions(app, appId);
            for (var i = 0; i < appSubs.length; ++i) {
                if (appSubs[i].api == subsCreateInfo.api)
                    return res.status(409).jsonp({ message: 'Application already has a subscription for API "' + subsCreateInfo.api + '".' });
            }

            debug('Subscription is new.');

            // Do we need to create an API key? Or did we get one passed in?
            // Or do we require approval? Admins never need approval
            var needsApproval = !isAdmin && apiPlan.needsApproval;
            var approvalInfos = null;
            if (needsApproval)
                approvalInfos = approvals.loadApprovals(app);

            var apiKey = null;
            var clientId = null;
            var clientSecret = null;
            var authMethod = "key-auth";
            if (!needsApproval) {
                debug('Subscription does not need approval, creating keys.');
                if (selectedApi.auth && selectedApi.auth.startsWith("oauth2")) { // oauth2
                    clientId = utils.createRandomId();
                    clientSecret = utils.createRandomId();
                    authMethod = selectedApi.auth;
                } else {
                    // Default to key-auth
                    apiKey = utils.createRandomId();
                    if (subsCreateInfo.apikey)
                        apiKey = subsCreateInfo.apikey;
                }
            } else {
                debug('Subscription needs approval.');
            }


            var newSubscription = {
                id: utils.createRandomId(),
                application: subsCreateInfo.application,
                api: subsCreateInfo.api,
                plan: subsCreateInfo.plan,
                apikey: apiKey,
                clientId: clientId,
                clientSecret: clientSecret,
                auth: selectedApi.auth,
                approved: !needsApproval,
                changedBy: loggedInUserId,
                changedDate: utils.getUtc(),
                _links: {
                    self: { href: '/applications/' + appId + '/subscriptions/' + subsCreateInfo.api },
                    application: { href: '/applications/' + appId },
                    apis: { href: '/apis' },
                    plans: { href: '/plans' }
                }
            };

            // Push new subscription
            appSubs.push(newSubscription);

            // Persist subscriptions; this will encrypt clientId and clientSecret
            subscriptions.saveSubscriptions(app, appId, appSubs);

            // Add to subscription index, if it has a clientId
            if (clientId) {
                newSubscription.clientId = clientId;
                newSubscription.clientSecret = clientSecret;
                subscriptions.saveSubscriptionIndexEntry(app, clientId, newSubscription);
            }
            // Add API index for subscription
            subscriptions.addSubscriptionApiIndexEntry(app, newSubscription);
            // For returning the subscription, include unencrypted key.
            if (apiKey)
                newSubscription.apikey = apiKey;

            if (needsApproval) {
                approvalInfos.push({
                    subscriptionId: newSubscription.id,
                    user: {
                        id: userInfo.id,
                        name: userInfo.name,
                        email: userInfo.email,
                    },
                    api: {
                        id: selectedApi.id,
                        name: selectedApi.name,
                        requiredGroup: selectedApi.requiredGroup
                    },
                    application: {
                        id: appInfo.id,
                        name: appInfo.name
                    },
                    plan: {
                        id: apiPlan.id,
                        name: apiPlan.name
                    }
                });
                approvals.saveApprovals(app, approvalInfos);
            }

            res.status(201).json(newSubscription);

            // Webhook it, man
            webhooks.logEvent(app, {
                action: webhooks.ACTION_ADD,
                entity: webhooks.ENTITY_SUBSCRIPTION,
                data: {
                    subscriptionId: newSubscription.id,
                    applicationId: appInfo.id,
                    apiId: selectedApi.id,
                    group: selectedApi.requiredGroup,
                    userId: userInfo.id,
                    planId: apiPlan.id
                }
            });

            if (needsApproval) {
                webhooks.logEvent(app, {
                    action: webhooks.ACTION_ADD,
                    entity: webhooks.ENTITY_APPROVAL,
                    data: {
                        userId: userInfo.id,
                        applicationId: appInfo.id,
                        apiId: selectedApi.id,
                        group: selectedApi.requiredGroup,
                        planId: apiPlan.id
                    }
                });
            }
        });
    });
};

subscriptions.getSubscription = function (app, res, applications, loggedInUserId, appId, apiId) {
    debug('getSubscription(): ' + appId + ', apiId: ' + apiId);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var isAllowed = false;
    var adminOrCollab = false;
    if (userInfo.admin) {
        isAllowed = true;
        adminOrCollab = true;
    }
    if (!isAllowed) {
        // Check for App rights
        var access = subscriptions.getOwnerRole(appInfo, userInfo);
        if (access) // Any role will do for GET
            isAllowed = true;
        if (ownerRoles.OWNER == access ||
            ownerRoles.COLLABORATOR == access)
            adminOrCollab = true;
    }
    if (!isAllowed)
        return res.status(403).jsonp({ message: 'Not allowed. User does not own application.' });

    const appSub = loadAndFindSubscription(app, appId, apiId);

    // Did we find it?
    if (!appSub)
        return res.status(404).jsonp({ message: 'API subscription not found for application. App: ' + appId + ', API: ' + apiId });
    // var appSub = appSubs[subsIndex];
    if (adminOrCollab) {
        appSub._links.deleteSubscription = {
            href: '/applications/' + appId + '/subscriptions/' + appSub.api,
            method: 'DELETE'
        };
    }

    // Return what we found
    res.json(appSub);
};

function loadAndFindSubscription(app, appId, apiId) {
    const appSubs = subscriptions.loadSubscriptions(app, appId);
    let subsIndex = -1;
    for (var i = 0; i < appSubs.length; ++i) {
        if (appSubs[i].api == apiId) {
            subsIndex = i;
            break;
        }
    }
    if (subsIndex < 0)
        return null;
    return appSubs[subsIndex];
}

function findSubsIndex(appSubs, apiId) {
    var subsIndex = -1;
    for (var i = 0; i < appSubs.length; ++i) {
        if (appSubs[i].api == apiId) {
            subsIndex = i;
            break;
        }
    }
    return subsIndex;
}

function findApprovalIndex(approvalInfos, appId, apiId) {
    var approvalIndex = -1;
    for (var i = 0; i < approvalInfos.length; ++i) {
        var appr = approvalInfos[i];
        if (appr.application.id == appId &&
            appr.api.id == apiId) {
            approvalIndex = i;
            break;
        }
    }
    return approvalIndex;
}

subscriptions.deleteSubscription = function (app, res, applications, loggedInUserId, appId, apiId) {
    debug('deleteSubscription(): ' + appId + ', apiId: ' + apiId);
    var appInfo = applications.loadApplication(app, appId);
    if (!appInfo)
        return res.status(404).jsonp({ message: 'Not found: ' + appId });
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed. User invalid.' });

    var isAllowed = false;
    if (userInfo.admin)
        isAllowed = true;
    if (!isAllowed) {
        // Check for App rights
        var access = subscriptions.getOwnerRole(appInfo, userInfo);
        // OWNERs and COLLABORATORs may do this.
        if (access &&
            ((access == ownerRoles.OWNER) ||
                (access == ownerRoles.COLLABORATOR))
        )
            isAllowed = true;
    }

    if (!isAllowed)
        return res.status(403).jsonp({ message: 'Not allowed. Only owners and collaborators may delete a subscription.' });

    utils.withLockedSubscriptions(app, res, appId, function () {
        utils.withLockedApprovals(app, res, function () {
            var appSubs = subscriptions.loadSubscriptions(app, appId);
            var subsIndex = findSubsIndex(appSubs, apiId);
            if (subsIndex < 0)
                return res.status(404).jsonp({ message: 'Not found. Subscription to API "' + apiId + '" does not exist: ' + appId });
            var subscriptionId = appSubs[subsIndex].id;
            var subscriptionData = appSubs[subsIndex];
            // We need to remove the subscription from the index, if necessary
            var clientId = subscriptionData.clientId;

            var approvalInfos = approvals.loadApprovals(app);
            var approvalIndex = findApprovalIndex(approvalInfos, appId, apiId);
            if (approvalIndex >= 0)
                approvalInfos.splice(approvalIndex, 1);

            appSubs.splice(subsIndex, 1);

            // Persist again
            subscriptions.saveSubscriptions(app, appId, appSubs);

            // If needed, persist approvals as well
            if (approvalIndex >= 0)
                approvals.saveApprovals(app, approvalInfos);

            // Now check the clientId
            if (clientId)
                subscriptions.deleteSubscriptionIndexEntry(app, clientId);
            // Delete the subscription from the API index
            subscriptions.deleteSubscriptionApiIndexEntry(app, subscriptionData);

            res.status(204).send('');

            webhooks.logEvent(app, {
                action: webhooks.ACTION_DELETE,
                entity: webhooks.ENTITY_SUBSCRIPTION,
                data: {
                    subscriptionId: subscriptionId,
                    applicationId: appId,
                    apiId: apiId,
                    userId: loggedInUserId,
                    auth: subscriptionData.auth
                }
            });
        });
    });
};

// This is for approving subscriptions
subscriptions.patchSubscription = function (app, res, applications, loggedInUserId, appId, apiId, patchBody) {
    debug('patchSubscription(): ' + appId + ', apiId: ' + apiId);
    debug(patchBody);
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed.' });
    if (!userInfo.admin && !userInfo.approver)
        return res.status(403).jsonp({ message: 'Not allowed. Only admins can patch a subscription.' });
    var appSubs = subscriptions.loadSubscriptions(app, appId);
    var subsIndex = findSubsIndex(appSubs, apiId);
    if (subsIndex < 0)
        return res.status(404).jsonp({ message: 'Not found. Subscription to API "' + apiId + '" does not exist: ' + appId });
    if (patchBody.approved) {
        // We want to approve of this subscriptions

        utils.withLockedSubscriptions(app, res, appId, function () {
            utils.withLockedApprovals(app, res, function () {
                var appSubs = subscriptions.loadSubscriptions(app, appId);
                var subsIndex = findSubsIndex(appSubs, apiId);
                if (subsIndex < 0)
                    return res.status(404).jsonp({ message: 'Not found. Subscription to API "' + apiId + '" does not exist: ' + appId });

                var approvalInfos = approvals.loadApprovals(app);
                var approvalIndex = findApprovalIndex(approvalInfos, appId, apiId);
                if (approvalIndex >= 0)
                    approvalInfos.splice(approvalIndex, 1);

                // Now set to approved
                var thisSubs = appSubs[subsIndex];
                thisSubs.approved = true;

                // In case a clientId is created, we need to temporary store it here, too,
                // as saveSubscriptions encrypts the ID.
                let tempClientId = null;
                let tempClientSecret = null;
                let tempApiKey = null;
                // And generate an apikey
                if (thisSubs.auth && thisSubs.auth.startsWith("oauth2")) { // oauth2
                    thisSubs.clientId = utils.createRandomId();
                    tempClientId = thisSubs.clientId;
                    thisSubs.clientSecret = utils.createRandomId();
                    tempClientSecret = thisSubs.clientSecret;
                } else {
                    thisSubs.apikey = utils.createRandomId();
                    tempApiKey = thisSubs.apikey;
                    thisSubs.auth = "key-auth";
                }
                thisSubs.changedBy = loggedInUserId;
                thisSubs.changedDate = utils.getUtc();

                // And persist the subscriptions
                subscriptions.saveSubscriptions(app, appId, appSubs);

                // If needed, persist approvals as well
                if (approvalIndex >= 0)
                    approvals.saveApprovals(app, approvalInfos);

                // And also possibly the subscription index
                if (tempClientId) {
                    // Replace the ID and Secret for returning, otherwise we'd return the encrypted
                    // strings. We don't want that.
                    thisSubs.clientId = tempClientId;
                    thisSubs.clientSecret = tempClientSecret;
                    subscriptions.saveSubscriptionIndexEntry(app, tempClientId, thisSubs);
                }
                // For returning the subscription data, include the unencrypted key.
                if (tempApiKey) {
                    thisSubs.apikey = tempApiKey;
                }

                res.json(thisSubs);

                webhooks.logEvent(app, {
                    action: webhooks.ACTION_UPDATE,
                    entity: webhooks.ENTITY_SUBSCRIPTION,
                    data: {
                        subscriptionId: thisSubs.id,
                        applicationId: appId,
                        apiId: apiId,
                        userId: loggedInUserId
                    }
                });
            });
        });
    } else {
        // No-op
        res.status(400).jsonp({ message: 'Bad request. Patching subscriptions can only be used to approve of subscriptions.' });
    }
};

subscriptions.getSubscriptionByClientId = function (app, res, applications, loggedInUserId, clientId) {
    debug('getSubscriptionByClientId()');
    var userInfo = users.loadUser(app, loggedInUserId);
    if (!userInfo)
        return res.status(403).jsonp({ message: 'Not allowed.' });
    if (!userInfo.admin)
        return res.status(403).jsonp({ message: 'Not allowed. Only admins may get subscriptions by client ID.' });
    const indexEntry = subscriptions.loadSubscriptionIndexEntry(app, clientId);
    if (!indexEntry)
        return res.status(404).json({ message: 'Not found.' });
    const appSub = loadAndFindSubscription(app, indexEntry.application, indexEntry.api);
    if (!appSub) {
        const errorMessage = 'Inconsistent state. Please notify operator: Subscription for app ' + indexEntry.application + ' to API ' + indexEntry.api + ' not found.';
        console.error("getSubscriptionByClientId(): " + errorMessage);
        return res.status(500).json({ message: errorMessage });
    }
    const appInfo = applications.loadApplication(app, indexEntry.application);
    if (!appInfo) {
        const errorMessage = 'Inconsistent state. Please notify operator: Application app ' + indexEntry.application + ' not found.';
        console.error("getSubscriptionByClientId(): " + errorMessage);
        return res.status(500).json({ message: errorMessage });
    }
    return res.json({
        subscription: appSub,
        application: appInfo
    });
};

module.exports = subscriptions;
