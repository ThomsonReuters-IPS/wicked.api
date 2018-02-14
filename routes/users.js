'use strict';

var utils = require('./utils');
var fs = require('fs');
var path = require('path');
var debug = require('debug')('portal-api:users');
var bcrypt = require('bcrypt-nodejs');
var webhooks = require('./webhooks');
var verifications = require('./verifications');
var authMiddleware = require('../auth-middleware');

var users = require('express').Router();

// ===== ENDPOINTS =====

users.post('/', authMiddleware.rejectFromKong, function (req, res) {
    users.createUser(req.app, res, req.body);
});

users.get('/', function (req, res, next) {
    if (req.query.customId)
        users.getUserByCustomId(req.app, res, req.query.customId);
    else if (req.query.email)
        users.getUserByEmail(req.app, res, req.query.email);
    else if (req.apiUserId)
        users.getUsers(req.app, res, req.apiUserId);
    else
        res.status(403).jsonp({ message: 'Not allowed. Unauthorized.' });
});

users.get('/:userId', function (req, res, next) {
    users.getUser(req.app, res, req.apiUserId, req.params.userId);
});

users.patch('/:userId', function (req, res, next) {
    if (req.get('X-VerificationId'))
        verifications.patchUserWithVerificationId(req.app, res, users, req.get('X-VerificationId'), req.params.userId, req.body);
    else if (req.apiUserId)
        users.patchUser(req.app, res, req.apiUserId, req.params.userId, req.body);
});

users.delete('/:userId', function (req, res, next) {
    users.deleteUser(req.app, res, req.apiUserId, req.params.userId);
});

users.delete('/:userId/password', function (req, res, next) {
    users.deletePassword(req.app, res, req.apiUserId, req.params.userId);
});


// ===== IMPLEMENTATION =====

users.BAD_PASSWORD = 'Password has to be at least 6 characters long, and less than 24 characters.';

users.isGoodPassword = function (password) {
    if (password.length < 6)
        return false;
    if (password.length > 24)
        return false;
    return true;
};

users.isUserAdmin = function (app, user) {
    debug('isUserAdmin()');
    var groups = utils.loadGroups(app);

    var isAdmin = false;
    for (var i = 0; i < user.groups.length; ++i) {
        var groupId = user.groups[i];
        for (var groupIndex = 0; groupIndex < groups.groups.length; ++groupIndex) {
            var group = groups.groups[groupIndex];
            if (groupId != group.id)
                continue;
            if (group.adminGroup) {
                isAdmin = true;
                break;
            }
        }
        if (isAdmin)
            break;
    }
    return isAdmin;
};

users.isUserApprover = function (app, user) {
    debug('isUserApprover()');
    var groups = utils.loadGroups(app);

    var isApprover = false;
    for (var i = 0; i < user.groups.length; ++i) {
        var groupId = user.groups[i];
        for (var groupIndex = 0; groupIndex < groups.groups.length; ++groupIndex) {
            var group = groups.groups[groupIndex];
            if (groupId != group.id)
                continue;
            if (group.approverGroup) {
                isApprover = true;
                break;
            }
        }
        if (isApprover)
            break;
    }
    return isApprover;
};

/* Does the user belong to a specific group, or is he an admin? */
users.hasUserGroup = function (app, userInfo, group) {
    debug('hasUserGroup()');
    var foundGroup = false;
    for (var i = 0; i < userInfo.groups.length; ++i) {
        if (userInfo.groups[i] == group)
            return true;
    }
    return userInfo.admin;
};

users.isActionAllowed = function (app, loggedInUserId, userId) {
    debug('isActionAllowed()');
    var userDir = path.join(utils.getDynamicDir(app), 'users');
    // Do we have a logged in user?
    if (!loggedInUserId)
        return false;
    if (loggedInUserId == userId || "1" == loggedInUserId)
        return true;
    // Is user an admin?
    var user = users.loadUser(app, loggedInUserId);
    if (!user) // User not found, action not allowed
        return false;
    return user.admin;
};

users.loadUser = function (app, userId) {
    debug('loadUser(): ' + userId);
    if (!userId)
        return null;
    var userDir = path.join(utils.getDynamicDir(app), 'users');
    var userFileName = path.join(userDir, userId + '.json');
    if (!fs.existsSync(userFileName))
        return null;
    //throw "users.loadUser - User not found: " + userId;
    var userInfo = JSON.parse(fs.readFileSync(userFileName, 'utf8'));
    if (userInfo.firstName && userInfo.lastName)
        userInfo.name = userInfo.firstName + ' ' + userInfo.lastName;
    else if (!userInfo.firstName && userInfo.lastName)
        userInfo.name = userInfo.lastName;
    else if (userInfo.firstName && !userInfo.lastName)
        userInfo.name = userInfo.firstName;
    else
        userInfo.name = 'Unknown User';

    userInfo.admin = users.isUserAdmin(app, userInfo);
    userInfo.approver = users.isUserApprover(app, userInfo);
    // Add generic links
    userInfo._links = {
        self: { href: '/users/' + userId },
        groups: { href: '/groups' }
    };

    if (userInfo.clientId)
        userInfo.clientId = utils.apiDecrypt(app, userInfo.clientId);
    if (userInfo.clientSecret)
        userInfo.clientSecret = utils.apiDecrypt(app, userInfo.clientSecret);

    return userInfo;
};

users.loadUserByEmail = function (app, userEmail) {
    debug('loadUserByEmail(): ' + userEmail);
    var userIndex = users.loadUserIndex(app);
    var email = userEmail.toLowerCase().trim();
    for (var i = 0; i < userIndex.length; ++i) {
        var userShort = userIndex[i];
        if (email == userShort.email) {
            var user = users.loadUser(app, userShort.id);
            if (!user)
                throw Error("User found in index, but could not be loaded: " + userEmail + ", id: " + userShort.id);
            return user;
        }
    }
    // Not found
    return null;
};

function checkValidatedUserGroup(app, userInfo) {
    debug('checkValidatedUserGroup()');
    if (!userInfo.validated)
        return;
    var globalSettings = utils.loadGlobals(app);
    if (!globalSettings.validatedUserGroup)
        return;
    var devGroup = globalSettings.validatedUserGroup;
    if (!userInfo.groups.find(function(group) { return group == devGroup; }))
        userInfo.groups.push(devGroup);
}

function checkClientIdAndSecret(app, userInfo) {
    debug('checkClientIdAndSecret()');
    var globalSettings = utils.loadGlobals(app);
    var entitled = false;
    if (userInfo.validated &&
        globalSettings.api &&
        globalSettings.api.portal &&
        globalSettings.api.portal.enableApi) {

        var requiredGroup = globalSettings.api.portal.requiredGroup;
        if (requiredGroup) {
            if (userInfo.groups &&
                userInfo.groups.find(function (group) { return group == requiredGroup; }))
                entitled = true;
        } else {
            entitled = true;
        }
    }

    if (entitled) {
        debug('entitled');
        if (!userInfo.clientId)
            userInfo.clientId = utils.createRandomId();
        if (!userInfo.clientSecret)
            userInfo.clientSecret = utils.createRandomId();
    } else {
        debug('not entitled');
        if (userInfo.clientId)
            delete userInfo.clientId;
        if (userInfo.clientSecret)
            delete userInfo.clientSecret;
    }
}

users.saveUser = function (app, user, userId) {
    debug('saveUser()');
    debug(user);
    var userDir = path.join(utils.getDynamicDir(app), 'users');
    var userFileName = path.join(userDir, user.id + '.json');
    // Things we don't want to persist
    var backupName = user.name;
    var backupAdmin = user.admin;
    var backupLinks = user._links;
    var backupClientId = user.clientId;
    var backupClientSecret = user.clientSecret;
    if (user.name)
        delete user.name;
    if (user.admin)
        delete user.admin;
    if (user._links)
        delete user._links;
    // Need to add developer group if validated?
    checkValidatedUserGroup(app, user);
    // ClientID and ClientSecret?
    checkClientIdAndSecret(app, user);
    user.changedBy = userId;
    user.changedDate = utils.getUtc();

    if (user.clientId)
        user.clientId = utils.apiEncrypt(app, user.clientId);
    if (user.clientSecret)
        user.clientSecret = utils.apiEncrypt(app, user.clientSecret);

    fs.writeFileSync(userFileName, JSON.stringify(user, null, 2), 'utf8');
    user.name = backupName;
    user.admin = backupAdmin;
    user._links = backupLinks;
    if (backupClientId)
        user.clientId = backupClientId;
    if (backupClientSecret)
        user.clientSecret = backupClientSecret;
};

users.loadUserIndex = function (app) {
    debug('loadUserIndex()');
    var userDir = path.join(utils.getDynamicDir(app), 'users');
    var userIndexFileName = path.join(userDir, '_index.json');
    return JSON.parse(fs.readFileSync(userIndexFileName, 'utf8'));
};

users.saveUserIndex = function (app, userIndex) {
    debug('saveUserIndex()');
    debug(userIndex);
    var userDir = path.join(utils.getDynamicDir(app), 'users');
    var userIndexFileName = path.join(userDir, '_index.json');
    fs.writeFileSync(userIndexFileName,
        JSON.stringify(userIndex, null, 2),
        'utf8');
};

users.createUser = function (app, res, userCreateInfo) {
    debug('createUser()');
    debug(userCreateInfo);
    utils.withLockedUserIndex(app, res, function () {
        if (!userCreateInfo.email && !userCreateInfo.customId)
            return res.status(400).jsonp({ message: 'Bad request. User needs email address.' });
        if (userCreateInfo.password &&
            !users.isGoodPassword(userCreateInfo.password))
            return res.status(400).jsonp({ message: users.BAD_PASSWORD });

        var userIndex = users.loadUserIndex(app);

        if (userCreateInfo.email)
            userCreateInfo.email = userCreateInfo.email.toLowerCase();

        // Check for email address and custom ID
        for (var i = 0; i < userIndex.length; ++i) {
            if (userCreateInfo.email && userIndex[i].email == userCreateInfo.email) {
                return res.status(409).jsonp({
                    message: 'A user with the given email address already exists.'
                });
            }
            if (userCreateInfo.customId && userIndex[i].customId) {
                if (userCreateInfo.customId == userIndex[i].customId)
                    return res.status(409).jsonp({ message: 'A user with the given custom ID already exists.' });
            }
        }

        // Form style create data?
        if (userCreateInfo.firstname &&
            !userCreateInfo.firstName)
            userCreateInfo.firstName = userCreateInfo.firstname;
        if (userCreateInfo.lastname &&
            !userCreateInfo.lastName)
            userCreateInfo.lastName = userCreateInfo.lastname;

        var newId = utils.createRandomId();
        var password = null;
        if (userCreateInfo.password)
            password = bcrypt.hashSync(userCreateInfo.password);
        if (!userCreateInfo.groups)
            userCreateInfo.groups = [];

        var newUser = {
            id: newId,
            customId: userCreateInfo.customId,
            firstName: userCreateInfo.firstName,
            lastName: userCreateInfo.lastName,
            validated: userCreateInfo.validated,
            email: userCreateInfo.email,
            password: password,
            applications: [],
            groups: userCreateInfo.groups
        };

        userIndex.push({
            id: newId,
            name: newUser.firstName + " " + newUser.lastName,
            email: newUser.email,
            customId: newUser.customId,
        });

        // First push user record
        users.saveUser(app, newUser, newId);

        // Then push index
        users.saveUserIndex(app, userIndex);

        // Re-load the user to get the links and stuff
        var freshUser = users.loadUser(app, newId);

        // Delete the password, if present
        if (freshUser.password)
            delete freshUser.password;

        res.status(201).json(freshUser);

        webhooks.logEvent(app, {
            action: webhooks.ACTION_ADD,
            entity: webhooks.ENTITY_USER,
            data: {
                userId: newId,
                email: userCreateInfo.email,
                customId: userCreateInfo.customId
            }
        });
    });
};

users.getUser = function (app, res, loggedInUserId, userId) {
    debug('getUser(): ' + userId);
    if (!users.isActionAllowed(app, loggedInUserId, userId))
        return res.status(403).jsonp({ message: 'Not allowed.' });
    var user = users.loadUser(app, userId);
    if (!user)
        return res.status(404).jsonp({ message: 'Not found.' });
    if (user.password) {
        delete user.password;
        user.hasPassword = true;
    }
    // You can't retrieve clientId and clientSecret for other users
    if (userId != loggedInUserId) {
        if (user.clientId)
            delete user.clientId;
        if (user.clientSecret)
            delete user.clientSecret;
    }

    res.json(user);
};

users.getUsers = function (app, res, loggedInUserId) {
    debug('getUsers()');
    var user = users.loadUser(app, loggedInUserId);
    if (!user)
        return res.status(400).jsonp({ message: 'Bad request. Unknown user.' });
    if (!user.admin)
        return res.status(403).jsonp({ message: 'Not allowed. Only admins can retrieve user list.' });
    var userIndex = users.loadUserIndex(app);
    res.json(userIndex);
};

users.getUserByCustomId = function (app, res, customId) {
    debug('getUserByCustomId(): ' + customId);
    // No security check here, only retrieves short info
    var userIndex = users.loadUserIndex(app);
    var index = -1;
    for (var i = 0; i < userIndex.length; ++i) {
        if (userIndex[i].customId == customId) {
            index = i;
            break;
        }
    }
    if (index < 0)
        return res.status(404).jsonp({ message: 'User with customId "' + customId + '" not found.' });
    res.json([userIndex[index]]);
};

users.getUserByEmail = function (app, res, email) {
    debug('getUserByEmail(): ' + email);
    // No security check here, only retrieves short info
    var userIndex = users.loadUserIndex(app);
    email = email.toLowerCase().trim();
    var index = -1;
    for (var i = 0; i < userIndex.length; ++i) {
        if (userIndex[i].email == email) {
            index = i;
            break;
        }
    }
    if (index < 0)
        return res.status(404).jsonp({ message: 'User with email "' + email + '" not found.' });
    res.json([userIndex[index]]);
};

users.getUserByEmailAndPassword = function (app, res, email, password) {
    debug('getUserByEmailAndPassword(): ' + email + ', password=***');
    var userInfo = users.loadUserByEmail(app, email);
    if (!userInfo)
        return res.status(404).jsonp({ message: 'User not found or password not correct.' });
    if (!userInfo.password)
        return res.status(400).jsonp({ message: 'Bad request. User has no defined password.' });
    if (!bcrypt.compareSync(password, userInfo.password))
        return res.status(403).jsonp({ message: 'Password not correct or user not found.' });
    delete userInfo.password;
    res.json([userInfo]);
};

users.patchUser = function (app, res, loggedInUserId, userId, userInfo) {
    debug('patchUser(): ' + userId);
    debug(userInfo);
    if (!users.isActionAllowed(app, loggedInUserId, userId))
        return res.status(403).jsonp({ message: 'Not allowed' });
    if (userInfo.password &&
        !users.isGoodPassword(userInfo.password))
        return res.status(400).jsonp({ message: users.BAD_PASSWORD });

    utils.withLockedUser(app, res, userId, function () {
        utils.withLockedUserIndex(app, res, function () {
            var user = users.loadUser(app, userId);
            if (!user)
                return res.status(404).jsonp({ message: 'Not found.' });
            if (userInfo.customId)
                if (userInfo.customId != user.customId)
                    return res.status(400).jsonp({ message: 'Bad request. Changing custom ID is not allowed.' });
            if (user.password &&
                userInfo.email &&
                (userInfo.email != user.email))
                return res.status(400).jsonp({ message: 'Bad request. You can not change the email address of a username with a local password.' });
            var userIndex = users.loadUserIndex(app);

            if (userInfo.firstName)
                user.firstName = userInfo.firstName;
            if (userInfo.lastName)
                user.lastName = userInfo.lastName;
            if (userInfo.groups)
                user.groups = userInfo.groups;
            if (userInfo.email)
                user.email = userInfo.email;
            if (userInfo.validated)
                user.validated = userInfo.validated;
            if (userInfo.password)
                user.password = bcrypt.hashSync(userInfo.password);

            for (var i = 0; i < userIndex.length; ++i) {
                if (userIndex[i].id == userId) {
                    // Use user variable, not userInfo; user has already been updated
                    userIndex[i].name = user.firstName + ' ' + user.lastName;
                    userIndex[i].email = user.email;
                    break;
                }
            }
            // Persist user
            users.saveUser(app, user, loggedInUserId);
            // Persist index
            users.saveUserIndex(app, userIndex);

            // Re-load user to refresh
            user = users.loadUser(app, user.id);

            // Delete password, if present
            if (user.password)
                delete user.password;
            res.json(user);

            webhooks.logEvent(app, {
                action: webhooks.ACTION_UPDATE,
                entity: webhooks.ENTITY_USER,
                data: {
                    updatedUserId: userId,
                    userId: loggedInUserId
                }
            });
        });
    });
};

users.deleteUser = function (app, res, loggedInUserId, userId) {
    debug('deleteUser(): ' + userId);
    if (!users.isActionAllowed(app, loggedInUserId, userId))
        return res.status(403).jsonp({ message: 'Not allowed.' });

    utils.withLockedUserIndex(app, res, function () {
        var userIndex = users.loadUserIndex(app);

        var index = -1;
        // Find user in index
        for (var i = 0; i < userIndex.length; ++i) {
            let user = userIndex[i];
            if (user.id == userId) {
                index = i;
                break;
            }
        }

        if (index < 0)
            return res.status(404).jsonp({ message: 'Not found.' });

        // Make sure the user does not have active applications
        let user = users.loadUser(app, userId);
        if (user) {
            if (user.applications.length > 0) {
                return res.status(409).jsonp({ message: 'User has applications; remove user from applications first.' });
            }
        } else {
            debug('User not found, but exists in index!');
            console.error("WARNING: User not found, but exists in index!");
        }

        // Remove from user index
        userIndex.splice(index, 1);

        // Write index (before deleting file, please, otherway around can create inconsistencies)
        users.saveUserIndex(app, userIndex);

        var userDir = path.join(utils.getDynamicDir(app), 'users');
        var userFileName = path.join(userDir, userId + '.json');
        // Delete user JSON
        if (fs.existsSync(userFileName))
            fs.unlinkSync(userFileName);

        res.status(204).json('');

        webhooks.logEvent(app, {
            action: webhooks.ACTION_DELETE,
            entity: webhooks.ENTITY_USER,
            data: {
                deletedUserId: userId,
                userId: loggedInUserId
            }
        });
    });
};

users.deletePassword = function (app, res, loggedInUserId, userId) {
    debug('deletePassword(): ' + userId);
    var adminUser = users.loadUser(app, loggedInUserId);
    if (!adminUser)
        return res.status(400).jsonp({ message: 'Bad request. Unknown user.' });
    if (!adminUser.admin)
        return res.status(403).jsonp({ message: 'Not allowed. Only admins can delete passwords.' });
    var user = users.loadUser(app, userId);
    if (!user)
        return res.status(404).jsonp({ message: 'User not found.' });
    if (!user.password)
        return res.status(204).send('');
    delete user.password;
    users.saveUser(app, user, loggedInUserId);
    return res.status(204).send('');
};

module.exports = users;
