'use strict';

let log = require('npmlog');

let bcrypt = require('bcrypt-nodejs');
let db = require('../db');
let tools = require('../tools');
let mailer = require('../mailer');
let settings = require('./settings');
let crypto = require('crypto');
let urllib = require('url');

/**
 * Fetches user by ID value
 *
 * @param {Number} id User id
 * @param {Function} callback Return an error or an user object
 */
module.exports.get = (id, callback) => {
    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        connection.query('SELECT id, username, email FROM users WHERE id=? LIMIT 1', [id], (err, rows) => {
            connection.release();

            if (err) {
                return callback(err);
            }

            if (!rows.length) {
                return callback(null, false);
            }

            let user = tools.convertKeys(rows[0]);
            return callback(null, user);
        });
    });
};

/**
 * Fetches user by username and password
 *
 * @param {String} username
 * @param {String} password
 * @param {Function} callback Return an error or authenticated user
 */
module.exports.authenticate = (username, password, callback) => {

    let login = (connection, callback) => {
        connection.query('SELECT id, password FROM users WHERE username=? OR email=? LIMIT 1', [username, username], (err, rows) => {
            if (err) {
                return callback(err);
            }

            if (!rows.length) {
                return callback(null, false);
            }

            bcrypt.compare(password, rows[0].password, (err, result) => {
                if (err) {
                    return callback(err);
                }
                if (!result) {
                    return callback(null, false);
                }
                return callback(null, {
                    id: rows[0].id,
                    username
                });
            });

        });
    };

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        login(connection, (err, user) => {
            connection.release();
            callback(err, user);
        });
    });
};

/**
 * Updates user password
 *
 * @param {Object} id User ID
 * @param {Object} updates
 * @param {Function} Return an error or success/fail
 */
module.exports.update = (id, updates, callback) => {

    if (!updates.email) {
        return callback(new Error('Email Address must be set'));
    }

    let update = (connection, callback) => {

        connection.query('SELECT password FROM users WHERE id=? LIMIT 1', [id], (err, rows) => {
            if (err) {
                return callback(err);
            }

            if (!rows.length) {
                return callback('Failed to check user data');
            }

            let keys = ['email'];
            let values = [updates.email];

            let finalize = () => {
                values.push(id);
                connection.query('UPDATE users SET ' + keys.map(key => key + '=?').join(', ') + ' WHERE id=? LIMIT 1', values, (err, result) => {
                    if (err) {
                        if (err.code === 'ER_DUP_ENTRY') {
                            err = new Error('Can\'t change email as another user with the same email address already exists');
                        }
                        return callback(err);
                    }
                    return callback(null, result.affectedRows);
                });
            };

            if (!updates.password && !updates.password2) {
                return finalize();
            }

            bcrypt.compare(updates.currentPassword, rows[0].password, (err, result) => {
                if (err) {
                    return callback(err);
                }
                if (!result) {
                    return callback('Incorrect current password');
                }

                if (!updates.password) {
                    return callback(new Error('New password not set'));
                }

                if (updates.password !== updates.password2) {
                    return callback(new Error('Passwords do not match'));
                }

                bcrypt.hash(updates.password, null, null, (err, hash) => {
                    if (err) {
                        return callback(err);
                    }

                    keys.push('password');
                    values.push(hash);

                    finalize();
                });
            });
        });
    };

    tools.validateEmail(updates.email, false, err => {
        if (err) {
            return callback(err);
        }

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }
            update(connection, (err, updated) => {
                connection.release();
                callback(err, updated);
            });
        });
    });
};

module.exports.sendReset = (username, callback) => {
    username = (username || '').toString().trim();

    if (!username) {
        return callback(new Error('Username must be set'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        connection.query('SELECT id, email, username FROM users WHERE username=? OR email=? LIMIT 1', [username, username], (err, rows) => {
            if (err) {
                connection.release();
                return callback(err);
            }

            if (!rows.length) {
                connection.release();
                return callback(null, false);
            }

            let resetToken = crypto.randomBytes(16).toString('base64').replace(/[^a-z0-9]/gi, '');
            connection.query('UPDATE users SET reset_token=?, reset_expire=NOW() + INTERVAL 1 HOUR WHERE id=? LIMIT 1', [resetToken, rows[0].id], err => {
                connection.release();
                if (err) {
                    return callback(err);
                }

                settings.list(['serviceUrl', 'adminEmail'], (err, configItems) => {
                    if (err) {
                        return callback(err);
                    }

                    mailer.sendMail({
                        from: {
                            address: configItems.adminEmail
                        },
                        to: {
                            address: rows[0].email
                        },
                        subject: 'Mailer password change request'
                    }, {
                        template: 'emails/password-reset.hbs',
                        data: {
                            username: rows[0].username,
                            confirmUrl: urllib.resolve(configItems.serviceUrl, '/users/reset') + '?token=' + encodeURIComponent(resetToken) + '&username=' + encodeURIComponent(rows[0].username)
                        }
                    }, err => {
                        if (err) {
                            log.error('Mail', err.stack); // eslint-disable-line no-console
                        }
                    });

                    callback(null, true);
                });
            });
        });
    });
};

module.exports.checkResetToken = (username, resetToken, callback) => {
    if (!username || !resetToken) {
        return callback(new Error('Missing username or reset token'));
    }
    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        connection.query('SELECT id FROM users WHERE username=? AND reset_token=? AND reset_expire > NOW() LIMIT 1', [username, resetToken], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }
            return callback(null, rows && rows.length || false);
        });
    });
};

module.exports.resetPassword = (data, callback) => {
    let updates = tools.convertKeys(data);

    if (!updates.username || !updates.resetToken) {
        return callback(new Error('Missing username or reset token'));
    }

    if (!updates.password || !updates.password2 || updates.password !== updates.password2) {
        return callback(new Error('Invalid new password'));
    }

    bcrypt.hash(updates.password, null, null, (err, hash) => {
        if (err) {
            return callback(err);
        }

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }
            connection.query('UPDATE users SET password=?, reset_token=NULL, reset_expire=NULL WHERE username=? AND reset_token=? AND reset_expire > NOW() LIMIT 1', [hash, updates.username, updates.resetToken], (err, result) => {
                connection.release();
                if (err) {
                    return callback(err);
                }
                return callback(null, result.affectedRows);
            });
        });
    });
};
