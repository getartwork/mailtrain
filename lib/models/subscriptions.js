'use strict';

let db = require('../db');
let shortid = require('shortid');
let tools = require('../tools');
let fields = require('./fields');
let geoip = require('geoip-ultralight');
let segments = require('./segments');

module.exports.list = (listId, start, limit, callback) => {
    listId = Number(listId) || 0;
    if (!listId) {
        return callback(new Error('Missing List ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }

        connection.query('SELECT SQL_CALC_FOUND_ROWS * FROM `subscription__' + listId + '` ORDER BY email LIMIT ? OFFSET ?', [limit, start], (err, rows) => {
            if (err) {
                connection.release();
                return callback(err);
            }
            connection.query('SELECT FOUND_ROWS() AS total', (err, total) => {
                connection.release();
                if (err) {
                    return callback(err);
                }

                let subscriptions = rows.map(row => tools.convertKeys(row));
                return callback(null, subscriptions, total && total[0] && total[0].total);
            });
        });
    });
};

module.exports.filter = (listId, request, columns, segmentId, callback) => {
    listId = Number(listId) || 0;
    segmentId = Number(segmentId) || 0;

    if (!listId) {
        return callback(new Error('Missing List ID'));
    }

    let processQuery = queryData => {

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }

            let query = 'SELECT COUNT(id) AS total FROM `subscription__' + listId + '`';
            let values = [];

            if (queryData.where) {
                query += ' WHERE ' + queryData.where;
                values = values.concat(queryData.values || []);
            }

            connection.query(query, values, (err, total) => {
                if (err) {
                    connection.release();
                    return callback(err);
                }
                total = total && total[0] && total[0].total || 0;

                let ordering = [];

                if (request.order && request.order.length) {

                    request.order.forEach(order => {
                        let orderField = columns[Number(order.column)];
                        let orderDirection = (order.dir || '').toString().toLowerCase() === 'desc' ? 'DESC' : 'ASC';
                        if (orderField) {
                            ordering.push('`' + orderField + '` ' + orderDirection);
                        }
                    });
                }

                if (!ordering.length) {
                    ordering.push('`email` ASC');
                }

                let args = [Number(request.length) || 50, Number(request.start) || 0];
                let query;

                if (request.search && request.search.value) {
                    query = 'SELECT SQL_CALC_FOUND_ROWS * FROM `subscription__' + listId + '` WHERE email LIKE ? OR first_name LIKE ? OR last_name LIKE ? ' + (queryData.where ? ' AND (' + queryData.where + ')' : '') + ' ORDER BY ' + ordering.join(', ') + ' LIMIT ? OFFSET ?';

                    let searchVal = '%' + request.search.value.replace(/\\/g, '\\\\').replace(/([%_])/g, '\\$1') + '%';
                    args = [searchVal, searchVal, searchVal].concat(queryData.values || []).concat(args);
                } else {
                    query = 'SELECT SQL_CALC_FOUND_ROWS * FROM `subscription__' + listId + '` WHERE 1 ' + (queryData.where ? ' AND (' + queryData.where + ')' : '') + ' ORDER BY ' + ordering.join(', ') + ' LIMIT ? OFFSET ?';
                    args = [].concat(queryData.values || []).concat(args);
                }

                connection.query(query, args, (err, rows) => {
                    if (err) {
                        connection.release();
                        return callback(err);
                    }
                    connection.query('SELECT FOUND_ROWS() AS total', (err, filteredTotal) => {
                        connection.release();
                        if (err) {
                            return callback(err);
                        }

                        let subscriptions = rows.map(row => tools.convertKeys(row));

                        filteredTotal = filteredTotal && filteredTotal[0] && filteredTotal[0].total || 0;
                        return callback(null, subscriptions, total, filteredTotal);
                    });
                });
            });
        });
    };

    if (segmentId) {
        segments.getQuery(segmentId, (err, queryData) => {
            if (err) {
                return callback(err);
            }
            processQuery(queryData);
        });
    } else {
        processQuery(false);
    }

};


module.exports.addConfirmation = (listId, email, data, callback) => {
    let cid = shortid.generate();

    tools.validateEmail(email, false, err => {
        if (err) {
            return callback(err);
        }

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }

            let query = 'INSERT INTO confirmations (cid, list, email, data) VALUES (?,?,?,?)';
            connection.query(query, [cid, listId, email, JSON.stringify(data || {})], (err, result) => {
                connection.release();
                if (err) {
                    return callback(err);
                }
                return callback(null, result && cid || false);
            });
        });
    });
};

module.exports.subscribe = (cid, optInIp, callback) => {
    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }

        let query = 'SELECT * FROM confirmations WHERE cid=? LIMIT 1';
        connection.query(query, [cid], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }

            if (!rows || !rows.length) {
                return callback(null, false);
            }

            let subscription;
            let listId = rows[0].list;
            let email = rows[0].email;
            try {
                subscription = JSON.parse(rows[0].data);
            } catch (E) {
                subscription = {};
            }

            let optInCountry = geoip.lookupCountry(optInIp) || null;
            module.exports.insert(listId, {
                email,
                cid,
                optInIp,
                optInCountry,
                status: 1
            }, subscription, err => {
                if (err) {
                    return callback(err);
                }

                db.getConnection((err, connection) => {
                    if (err) {
                        return callback(err);
                    }
                    connection.query('DELETE FROM confirmations WHERE `cid`=? LIMIT 1', [cid], () => {
                        connection.release();
                        callback(null, {
                            list: listId,
                            email
                        });
                    });
                });
            });
        });
    });
};

module.exports.insert = (listId, meta, subscription, callback) => {

    meta = tools.convertKeys(meta);
    subscription = tools.convertKeys(subscription);

    meta.email = meta.email || subscription.email;
    meta.cid = meta.cid || shortid.generate();

    fields.list(listId, (err, fieldList) => {
        if (err) {
            return callback(err);
        }

        let insertKeys = ['email', 'cid', 'opt_in_ip', 'opt_in_country', 'imported'];
        let insertValues = [meta.email, meta.cid, meta.optInIp || null, meta.optInCountry || null, meta.imported || null];
        let keys = [];
        let values = [];

        let allowedKeys = ['first_name', 'last_name'];
        Object.keys(subscription).forEach(key => {
            let value = subscription[key];
            key = tools.toDbKey(key);
            if (allowedKeys.indexOf(key) >= 0) {
                keys.push(key);
                values.push(value);
            }
        });

        fields.getValues(fields.getRow(fieldList, subscription, true, true), true).forEach(field => {
            keys.push(field.key);
            values.push(field.value);
        });

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }

            connection.beginTransaction(err => {
                if (err) {
                    return callback(err);
                }

                let query = 'SELECT id, status FROM `subscription__' + listId + '` WHERE email=? OR cid=? LIMIT 1';
                connection.query(query, [meta.email, meta.cid], (err, rows) => {
                    if (err) {
                        return connection.rollback(() => {
                            connection.release();
                            return callback(err);
                        });
                    }

                    let query;
                    let queryArgs;
                    let existing = rows && rows[0] || false;
                    let entryId = existing ? existing.id : false;

                    meta.status = meta.status || (existing ? existing.status : 1);

                    let statusChange = !existing || existing.status !== meta.status;
                    let statusDirection;

                    if (statusChange) {
                        keys.push('status', 'status_change');
                        values.push(meta.status, new Date());
                        statusDirection = !existing ? (meta.status === 1 ? '+' : '-') : (existing.status === 1 ? '-' : '+');
                    }

                    if (!existing) {
                        // insert as new
                        keys = insertKeys.concat(keys);
                        queryArgs = values = insertValues.concat(values);
                        query = 'INSERT INTO `subscription__' + listId + '` (`' + keys.join('`, `') + '`) VALUES (' + keys.map(() => '?').join(',') + ')';
                    } else {
                        // update existing
                        queryArgs = values.concat(existing.id);
                        query = 'UPDATE `subscription__' + listId + '` SET ' + keys.map(key => '`' + key + '`=?') + ' WHERE id=? LIMIT 1';
                    }

                    connection.query(query, queryArgs, (err, result) => {
                        if (err) {
                            return connection.rollback(() => {
                                connection.release();
                                return callback(err);
                            });
                        }

                        entryId = result.insertId || entryId;

                        if (statusChange) {
                            connection.query('UPDATE lists SET `subscribers`=`subscribers`' + statusDirection + '1 WHERE id=?', [listId], err => {
                                if (err) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        return callback(err);
                                    });
                                }
                                connection.commit(err => {
                                    if (err) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            return callback(err);
                                        });
                                    }
                                    connection.release();
                                    return callback(null, entryId);
                                });
                            });
                        } else {
                            connection.commit(err => {
                                if (err) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        return callback(err);
                                    });
                                }
                                connection.release();
                                return callback(null, entryId);
                            });
                        }
                    });
                });
            });
        });
    });
};

module.exports.get = (listId, cid, callback) => {
    cid = (cid || '').toString().trim();

    if (!cid) {
        return callback(new Error('Missing Subbscription ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }

        connection.query('SELECT * FROM `subscription__' + listId + '` WHERE cid=?', [cid], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }

            if (!rows || !rows.length) {
                return callback(null, false);
            }

            let list = tools.convertKeys(rows[0]);
            return callback(null, list);
        });
    });
};

module.exports.update = (listId, cid, updates, allowEmail, callback) => {
    updates = tools.convertKeys(updates);
    listId = Number(listId) || 0;
    cid = (cid || '').toString().trim();

    let keys = [];
    let values = [];

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    if (!cid) {
        return callback(new Error('Missing subscription ID'));
    }

    fields.list(listId, (err, fieldList) => {
        if (err) {
            return callback(err);
        }

        let allowedKeys = ['first_name', 'last_name'];

        if (allowEmail) {
            allowedKeys.unshift('email');
        }

        Object.keys(updates).forEach(key => {
            let value = updates[key];
            key = tools.toDbKey(key);
            if (allowedKeys.indexOf(key) >= 0) {
                keys.push(key);
                values.push(value);
            }
        });

        fields.getValues(fields.getRow(fieldList, updates, true, true), true).forEach(field => {
            keys.push(field.key);
            values.push(field.value);
        });

        if (!values.length) {
            return callback(null, false);
        }

        db.getConnection((err, connection) => {
            if (err) {
                return callback(err);
            }

            values.push(cid);
            connection.query('UPDATE `subscription__' + listId + '` SET ' + keys.map(key => '`' + key + '`=?').join(', ') + ' WHERE `cid`=? LIMIT 1', values, (err, result) => {
                connection.release();
                if (err) {
                    return callback(err);
                }
                return callback(null, result && result.affectedRows || false);
            });
        });
    });
};

module.exports.unsubscribe = (listId, email, campaignId, callback) => {
    listId = Number(listId) || 0;
    email = (email || '').toString().trim();

    campaignId = (campaignId || '').toString().trim() || false;

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    if (!email) {
        return callback(new Error('Missing email address'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }

        connection.query('SELECT id, status FROM `subscription__' + listId + '` WHERE `email`=?', [email], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }
            if (!rows || !rows.length || rows[0].status !== 1) {
                return callback(null, false);
            }

            let id = rows[0].id;
            module.exports.changeStatus(id, listId, campaignId, 2, callback);
        });
    });
};

module.exports.changeStatus = (id, listId, campaignId, status, callback) => {
    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        connection.beginTransaction(err => {
            if (err) {
                return callback(err);
            }

            connection.query('SELECT `status` FROM `subscription__' + listId + '` WHERE id=? LIMIT 1', [id], (err, rows) => {
                if (err) {
                    return connection.rollback(() => {
                        connection.release();
                        return callback(err);
                    });
                }

                if (!rows || !rows.length) {
                    return connection.rollback(() => {
                        connection.release();
                        return callback(null, false);
                    });
                }

                let oldStatus = rows[0].status;
                let statusChange = oldStatus !== status;
                let statusDirection;

                if (!statusChange) {
                    return connection.rollback(() => {
                        connection.release();
                        return callback(null, true);
                    });
                }

                if (statusChange && oldStatus === 1 || status === 1) {
                    statusDirection = status === 1 ? '+' : '-';
                }

                connection.query('UPDATE `subscription__' + listId + '` SET `status`=?, `status_change`=NOW() WHERE id=? LIMIT 1', [status, id], err => {
                    if (err) {
                        return connection.rollback(() => {
                            connection.release();
                            return callback(err);
                        });
                    }

                    if (!statusDirection) {
                        return connection.commit(err => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    return callback(err);
                                });
                            }
                            connection.release();
                            return callback(null, true);
                        });
                    }

                    connection.query('UPDATE `lists` SET `subscribers`=`subscribers`' + statusDirection + '1 WHERE id=? LIMIT 1', [listId], err => {
                        if (err) {
                            return connection.rollback(() => {
                                connection.release();
                                return callback(err);
                            });
                        }

                        if (!campaignId) {
                            return connection.commit(err => {
                                if (err) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        return callback(err);
                                    });
                                }
                                connection.release();
                                return callback(null, true);
                            });
                        }

                        connection.query('UPDATE `campaigns` SET `unsubscribed`=`unsubscribed`+1 WHERE `cid`=? LIMIT 1', [campaignId], err => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    return callback(err);
                                });
                            }
                            return connection.commit(err => {
                                if (err) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        return callback(err);
                                    });
                                }
                                connection.release();
                                return callback(null, true);
                            });
                        });
                    });
                });
            });
        });
    });
};

module.exports.delete = (listId, cid, callback) => {
    listId = Number(listId) || 0;
    cid = (cid || '').toString().trim();

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    if (!cid) {
        return callback(new Error('Missing subscription ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }

        connection.query('SELECT id, email, status FROM `subscription__' + listId + '` WHERE cid=? LIMIT 1', [cid], (err, rows) => {
            if (err) {
                connection.release();
                return callback(err);
            }

            let subscription = rows && rows[0];
            if (!subscription) {
                connection.release();
                return callback(null, false);
            }

            connection.beginTransaction(err => {
                if (err) {
                    return callback(err);
                }

                connection.query('DELETE FROM `subscription__' + listId + '` WHERE cid=? LIMIT 1', [cid], err => {
                    if (err) {
                        return connection.rollback(() => {
                            connection.release();
                            return callback(err);
                        });
                    }

                    if (subscription.status !== 1) {
                        return connection.commit(err => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    return callback(err);
                                });
                            }
                            connection.release();
                            return callback(null, subscription.email);
                        });
                    }

                    connection.query('UPDATE lists SET subscribers=subscribers-1 WHERE id=? LIMIT 1', [listId], err => {
                        if (err) {
                            return connection.rollback(() => {
                                connection.release();
                                return callback(err);
                            });
                        }
                        connection.commit(err => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    return callback(err);
                                });
                            }
                            connection.release();
                            return callback(null, subscription.email);
                        });
                    });
                });
            });
        });
    });
};

module.exports.createImport = (listId, type, path, size, delimiter, mapping, callback) => {
    listId = Number(listId) || 0;
    type = Number(type) || 1;

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        let query = 'INSERT INTO importer (`list`, `type`, `path`, `size`, `delimiter`, `mapping`) VALUES(?,?,?,?,?,?)';
        connection.query(query, [listId, type, path, size, delimiter, JSON.stringify(mapping)], (err, result) => {
            connection.release();
            if (err) {
                return callback(err);
            }
            return callback(null, result && result.insertId || false);
        });
    });
};

module.exports.updateImport = (listId, importId, data, callback) => {
    listId = Number(listId) || 0;
    importId = Number(importId) || 0;

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    if (importId < 1) {
        return callback(new Error('Missing Import ID'));
    }

    let keys = [];
    let values = [];

    let allowedKeys = ['type', 'path', 'size', 'delimiter', 'status', 'error', 'processed', 'mapping', 'finished'];
    Object.keys(data).forEach(key => {
        let value = data[key];
        key = tools.toDbKey(key);
        if (allowedKeys.indexOf(key) >= 0) {
            keys.push(key);
            values.push(value);
        }
    });

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        let query = 'UPDATE importer SET ' + keys.map(key => '`' + key + '`=?') + ' WHERE id=? AND list=? LIMIT 1';
        connection.query(query, values.concat([importId, listId]), (err, result) => {
            connection.release();
            if (err) {
                return callback(err);
            }
            return callback(null, result && result.affectedRows || false);
        });
    });
};

module.exports.getImport = (listId, importId, callback) => {
    listId = Number(listId) || 0;
    importId = Number(importId) || 0;

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    if (importId < 1) {
        return callback(new Error('Missing Import ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        let query = 'SELECT * FROM importer WHERE id=? AND list=? LIMIT 1';
        connection.query(query, [importId, listId], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }

            if (!rows || !rows.length) {
                return callback(null, false);
            }

            let importer = tools.convertKeys(rows[0]);
            try {
                importer.mapping = JSON.parse(importer.mapping);
            } catch (E) {
                importer.mapping = {
                    columns: []
                };
            }

            return callback(null, importer);
        });
    });
};

module.exports.listImports = (listId, callback) => {
    listId = Number(listId) || 0;

    if (listId < 1) {
        return callback(new Error('Missing List ID'));
    }

    db.getConnection((err, connection) => {
        if (err) {
            return callback(err);
        }
        let query = 'SELECT * FROM importer WHERE list=? AND status > 0 ORDER BY id DESC';
        connection.query(query, [listId], (err, rows) => {
            connection.release();
            if (err) {
                return callback(err);
            }

            if (!rows || !rows.length) {
                return callback(null, []);
            }

            let imports = rows.map(row => {
                let importer = tools.convertKeys(row);
                try {
                    importer.mapping = JSON.parse(importer.mapping);
                } catch (E) {
                    importer.mapping = {
                        columns: []
                    };
                }
                return importer;
            });

            return callback(null, imports);
        });
    });
};
