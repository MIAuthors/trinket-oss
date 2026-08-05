var errors       = require('@hapi/boom')
  , config       = require('config')
  , Trinket      = require('../models/trinket')
  , _            = require('underscore');

module.exports = {
  list : function(request, reply) {
    var getUserId;

    if (request.query.user && request.user.hasRole("admin")) {
      getUserId = function() {
        return User.findById(request.query.user);
      }
    }
    else {
      getUserId = function() { return Promise.resolve(null); };
    }

    return getUserId()
      .then(function(user) {
        return Folder.findByOwner(user || request.user);
      })
      .then(function(folders) {
        folders.forEach(function(folder) {
          folder.trinketCount = folder.trinkets.length;
        });
        return request.success({
          data : folders
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  listView : function(request, reply) {
    return request.success();
  },
  trinkets : async function(request, reply) {
    var folder = request.pre.folder;
    var url = '/api/trinkets' + request.url.search + '&folder=' + folder.id;

    try {
      var response = await request.server.inject({
        url     : url,
        method  : 'get',
        headers : {
          'content-type' : 'application/json',
          'accept'       : 'application/json'
        },
        auth    : {
          strategy    : 'session',
          credentials : request.auth.credentials
        }
      });

      return request.success({
        data : response.result.data
      });
    } catch (err) {
      return reply(err);
    }
  },
  create : function(request, reply) {
    var folder = new Folder(request.payload);
    folder.setOwner(request.user);
    folder.ownerSlug = request.user.username;

    folder.save(function(err, folder) {
      if (err) {
        if (err.code === 11000) {
          return request.fail({
              err     : err
            , message : "You already have a folder with this name. Please choose another."
          });
        }

        // unknown failure
        return request.fail({
            err     : err
          , message : err.message
        });
      }

      return request.user.grant("folder-owner", "folder", { id : folder.id })
        .then(function() {
          folder._owner = folder._owner.id;
          return request.success({
              success : true
            , folder  : folder
          });
        });
    });
  },
  update : function(request, reply) {
    var folder = request.pre.folder
      , updatedFolder;

    if (request.user.hasPermission("update-folder-details", "folder", { id : folder.id })) {
      folder.set(request.payload);
      return folder.save()
        .then(function(result) {
          updatedFolder = result;

          // Update trinkets with new folder info (fire-and-forget)
          if (updatedFolder.trinkets && updatedFolder.trinkets.length) {
            updatedFolder.trinkets.forEach(function(folderTrinket) {
              Trinket.findById(folderTrinket.trinketId)
                .then(function(trinket) {
                  if (trinket && trinket.folder) {
                    trinket.folder.name       = updatedFolder.name;
                    trinket.folder.folderSlug = updatedFolder.slug;
                    return trinket.save();
                  }
                })
                .catch(function(err) {
                  console.error('Failed to update trinket folder info:', err.message);
                });
            });
          }

          return request.success({
              success : true
            , folder  : updatedFolder
          });
        })
        .catch(function(err) {
          if (err.code === 11000) {
            return request.fail({
                success : false
              , message : "You already have a folder with this name. Please choose another."
            });
          }

          // unknown error
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  },
  deleteFolder : function(request, reply) {
    var folder = request.pre.folder;

    if (request.user.hasRole("folder-owner", "folder", { id : folder.id })) {
      return folder.deleteFolder()
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  }
};
