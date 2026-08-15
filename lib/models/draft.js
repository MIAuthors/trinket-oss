var model        = require('./model')
  , AssetSchema  = require('./asset')
  , ObjectId     = require('mongoose').SchemaTypes.ObjectId
  , schema       = {
        user             : { type : ObjectId, ref : 'User', required : true, index : true }
      , trinket          : { type : ObjectId, ref : 'Snippet' }
      , code             : { type : String, default : '' }
      , assets           : [AssetSchema]
      , settings         : {
          autofocusEnabled : { type : Boolean, default : true },
          testsEnabled     : { type : Boolean, default : false },
          runtime          : { type : String, enum : ['', 'worker', 'main'], default : '' }
        }
    };

function findOneAndUpdate(query, update) {
  // findOneAndUpdate doesn't fire pre save hook
  update.lastUpdated = Date.now();

  return this.model.findOneAndUpdate(query, update, { upsert : true, new: true }).exec();
}

function findOneMoreRecent(query) {
  var lastUpdated;
  if (query.lastUpdated) { // last date the trinket was saved
    lastUpdated = new Date(query.lastUpdated);
    delete query.lastUpdated;
  }

  return this.model.findOne(query).exec()
    .then(function(draft) {
      if (!draft) {
        return;
      }

      if (lastUpdated) {
        var draftUpdated = new Date(draft.lastUpdated);

        // if trinket was saved more recently, don't return draft
        if (lastUpdated.getTime() > draftUpdated.getTime()) {
          return;
        }
      }

      return draft;
    });
}

function discard(query) {
  return this.model.deleteMany(query).exec();
}

function updateAsset(asset) {
  var query, update, updateOptions;

  query = {
    assets : {
      "$elemMatch" : {
        id : asset
      }
    }
  };

  update = {
    "$set" : {
        "assets.$.url"       : asset.url
      , "assets.$.name"      : asset.name
      , "assets.$.thumbnail" : asset.thumbnail
    }
  };

  updateOptions = { new : true };

  return Draft.privateModel.updateOne(query, update, updateOptions).exec();
}

var Draft = model.create('Draft', {
    schema       : schema
  , classMethods : {
        findOneAndUpdate  : findOneAndUpdate
      , findOneMoreRecent : findOneMoreRecent
      , discard           : discard
      , updateAsset       : updateAsset
    }
  , publicSpec : {
        user         : 1
      , trinket      : 1
      , code         : 1
      , assets       : 1
      , settings     : 1
    }
});

module.exports = Draft.publicModel;
