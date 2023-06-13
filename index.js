var mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    Model = mongoose.Model,
    util = require('util');

function parseFieldNames (options) {
    var fieldNameDeleted = options.fieldNameDeleted || 'deleted';
    var fieldNameDeletedAt = options.fieldNameDeletedAt || 'deletedAt'
    var fieldNameDeletedBy = options.fieldNameDeletedBy || 'deletedBy'

    return {
        fieldNameDeleted,
        fieldNameDeletedAt,
        fieldNameDeletedBy
    }
}

/**
 * This code is taken from official mongoose repository
 * https://github.com/Automattic/mongoose/blob/master/lib/query.js#L3847-L3873
 */
function parseUpdateArguments (conditions, doc, options, callback) {
    if ('function' === typeof options) {
        // .update(conditions, doc, callback)
        callback = options;
        options = null;
    } else if ('function' === typeof doc) {
        // .update(doc, callback);
        callback = doc;
        doc = conditions;
        conditions = {};
        options = null;
    } else if ('function' === typeof conditions) {
        // .update(callback)
        callback = conditions;
        conditions = undefined;
        doc = undefined;
        options = undefined;
    } else if (typeof conditions === 'object' && !doc && !options && !callback) {
        // .update(doc)
        doc = conditions;
        conditions = undefined;
        options = undefined;
        callback = undefined;
    }

    var args = [];

    if (conditions) args.push(conditions);
    if (doc) args.push(doc);
    if (options) args.push(options);
    if (callback) args.push(callback);

    return args;
}

function parseIndexFields (options) {
    var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(options);

    var indexFields = {
        [fieldNameDeleted]: false,
        [fieldNameDeletedAt]: false,
        deletedBy: false
    };

    if (!options.indexFields) {
        return indexFields;
    }

    if ((typeof options.indexFields === 'string' || options.indexFields instanceof String) && options.indexFields === 'all') {
        indexFields[fieldNameDeleted] = indexFields[fieldNameDeletedAt] = indexFields.deletedBy = true;
    }

    if (typeof(options.indexFields) === "boolean" && options.indexFields === true) {
        indexFields[fieldNameDeleted] = indexFields[fieldNameDeletedAt] = indexFields.deletedBy = true;
    }

    if (Array.isArray(options.indexFields)) {
        indexFields[fieldNameDeleted] = options.indexFields.indexOf(fieldNameDeleted) > -1;
        indexFields[fieldNameDeletedAt] = options.indexFields.indexOf(fieldNameDeletedAt) > -1;
        indexFields[fieldNameDeletedBy] = options.indexFields.indexOf(fieldNameDeletedBy) > -1;
    }

    return indexFields;
}

function createSchemaObject (typeKey, typeValue, options) {
    options[typeKey] = typeValue;
    return options;
}

module.exports = function (schema, options) {
    options = options || {};

    // Add plugin specific option to the schema object so we can easily use it in methods and statics
    schema.options.softDeleteOptions = options;

    var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(options);

    var indexFields = parseIndexFields(options);

    var typeKey = schema.options.typeKey;
    var mongooseMajorVersion = +mongoose.version[0]; // 4, 5...
    var mainUpdateMethod = mongooseMajorVersion < 5 ? 'update' : 'updateMany';
    var mainUpdateWithDeletedMethod = mainUpdateMethod + 'WithDeleted';

    function updateDocumentsByQuery(schema, conditions, updateQuery, callback) {
        if (schema[mainUpdateWithDeletedMethod]) {
            return schema[mainUpdateWithDeletedMethod](conditions, updateQuery, { multi: true }, callback);
        } else {
            return schema[mainUpdateMethod](conditions, updateQuery, { multi: true }, callback);
        }
    }

    // schema.add({ deleted: createSchemaObject(typeKey, Boolean, { default: false, index: indexFields.deleted }) });
    schema.add({ [fieldNameDeleted]: createSchemaObject(typeKey, Boolean, { default: false, index: indexFields[fieldNameDeleted] }) });

    if (options.deletedAt === true) {
        schema.add({ [fieldNameDeletedAt]: createSchemaObject(typeKey, Date, { index: indexFields[fieldNameDeletedAt] }) });
    }

    if (options.deletedBy === true) {
        schema.add({ [fieldNameDeletedBy]: createSchemaObject(typeKey, options.deletedByType || Schema.Types.ObjectId, { index: indexFields[fieldNameDeletedBy] }) });
    }

    var use$neOperator = true;
    if (options.use$neOperator !== undefined && typeof options.use$neOperator === "boolean") {
        use$neOperator = options.use$neOperator;
    }

    schema.pre('save', function (next) {
        if (!this[fieldNameDeleted]) {
            this[fieldNameDeleted] = false;
        }
        next();
    });

    if (options.overrideMethods) {
        var overrideItems = options.overrideMethods;
        var overridableMethods = ['count', 'countDocuments', 'find', 'findOne', 'findOneAndUpdate', 'update', 'updateOne', 'updateMany', 'aggregate'];
        var finalList = [];

        if ((typeof overrideItems === 'string' || overrideItems instanceof String) && overrideItems === 'all') {
            finalList = overridableMethods;
        }

        if (typeof(overrideItems) === "boolean" && overrideItems === true) {
            finalList = overridableMethods;
        }

        if (Array.isArray(overrideItems)) {
            overrideItems.forEach(function(method) {
                if (overridableMethods.indexOf(method) > -1) {
                    finalList.push(method);
                }
            });
        }

        if (finalList.indexOf('aggregate') > -1) {
            schema.pre('aggregate', function() {
                var firstMatch = this.pipeline()[0];

                if(firstMatch.$match?.[fieldNameDeleted]?.$ne !== false){
                    if(firstMatch.$match?.showAllDocuments === 'true'){
                        var {showAllDocuments, ...replacement} = firstMatch.$match;
                        this.pipeline().shift();
                        if(Object.keys(replacement).length > 0){
                            this.pipeline().unshift({ $match: replacement });
                        }
                    }else{
                        this.pipeline().unshift({ $match: { [fieldNameDeleted]: { '$ne': true } } });
                    }
                }
            });
        }

        finalList.forEach(function(method) {
            if (['count', 'countDocuments', 'find', 'findOne'].indexOf(method) > -1) {
                var modelMethodName = method;

                schema.statics[method] = function () {
                    var query = Model[modelMethodName].apply(this, arguments);
                    if (!arguments[2] || arguments[2].withDeleted !== true) {
                        if (use$neOperator) {
                            query.where(fieldNameDeleted).ne(true);
                        } else {
                            query.where({[fieldNameDeleted]: false});
                        }
                    }
                    return query;
                };
                schema.statics[method + 'Deleted'] = function () {
                    if (use$neOperator) {
                        return Model[modelMethodName].apply(this, arguments).where(fieldNameDeleted).ne(false);
                    } else {
                        return Model[modelMethodName].apply(this, arguments).where({[fieldNameDeleted]: true});
                    }
                };
                schema.statics[method + 'WithDeleted'] = function () {
                    return Model[modelMethodName].apply(this, arguments);
                };
            } else {
                if (method === 'aggregate') {
                    schema.statics[method + 'Deleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var match = { $match : { [fieldNameDeleted] : {'$ne': false } } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var match = { $match : { showAllDocuments : 'true' } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                        return Model[method].apply(this, args);
                    };
                } else {
                    schema.statics[method] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {
                            args[0][fieldNameDeleted] = {'$ne': true};
                        } else {
                            args[0][fieldNameDeleted] = false;
                        }

                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'Deleted'] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {
                            args[0][fieldNameDeleted] = {'$ne': false};
                        } else {
                            args[0][fieldNameDeleted] = true;
                        }

                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        return Model[method].apply(this, arguments);
                    };
                }
            }
        });
    }

    schema.methods.delete = function (deletedBy, cb) {
        var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(schema.options.softDeleteOptions);

        if (typeof deletedBy === 'function') {
          cb = deletedBy;
          deletedBy = null;
        }

        this[fieldNameDeleted] = true;

        if (schema.path(fieldNameDeletedAt)) {
            this[fieldNameDeletedAt] = new Date();
        }

        if (schema.path(fieldNameDeletedBy)) {
            this[fieldNameDeletedBy] = deletedBy;
        }

        if (options.validateBeforeDelete === false) {
            return this.save({ validateBeforeSave: false }, cb);
        }

        return this.save(cb);
    };

    schema.statics.delete =  function (conditions, deletedBy, callback) {
        var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(schema.options.softDeleteOptions);

        if (typeof deletedBy === 'function') {
            callback = deletedBy;
            conditions = conditions;
            deletedBy = null;
        } else if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
            deletedBy = null;
        }

        var doc = {
            [fieldNameDeleted]: true
        };

        if (schema.path(fieldNameDeletedAt)) {
            doc[fieldNameDeletedAt] = new Date();
        }

        if (schema.path(fieldNameDeletedBy)) {
            doc[fieldNameDeletedBy] = deletedBy;
        }

        return updateDocumentsByQuery(this, conditions, doc, callback);
    };

    schema.statics.deleteById =  function (id, deletedBy, callback) {
        if (arguments.length === 0 || typeof id === 'function') {
            var msg = 'First argument is mandatory and must not be a function.';
            throw new TypeError(msg);
        }

        var conditions = {
            _id: id
        };

        return this.delete(conditions, deletedBy, callback);
    };

    schema.methods.restore = function (callback) {
        var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(schema.options.softDeleteOptions);

        this[fieldNameDeleted] = false;
        this[fieldNameDeletedAt] = undefined;
        this[fieldNameDeletedBy] = undefined;

        if (options.validateBeforeRestore === false) {
            return this.save({ validateBeforeSave: false }, callback);
        }

        return this.save(callback);
    };

    schema.statics.restore =  function (conditions, callback) {
        var { fieldNameDeleted, fieldNameDeletedAt, fieldNameDeletedBy } = parseFieldNames(schema.options.softDeleteOptions);

        if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
        }

        var doc = {
            $unset:{
                [fieldNameDeleted]: true,
                [fieldNameDeletedAt]: true,
                [fieldNameDeletedBy]: true
            }
        };

        return updateDocumentsByQuery(this, conditions, doc, callback);
    };
};
