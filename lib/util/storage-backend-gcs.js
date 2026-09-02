var config = require('config');

var _storage;
function getStorage() {
  if (!_storage) {
    var Storage = require('@google-cloud/storage').Storage;
    var projectId = (config.db.firestore && config.db.firestore.projectId) || process.env.GOOGLE_CLOUD_PROJECT;
    _storage = new Storage(projectId ? { projectId: projectId } : {});
  }
  return _storage;
}

module.exports = {
  // opts is optional and may be omitted entirely: upload(b, k, s, type, cb).
  // Currently carries contentDisposition, which the export archive needs so the
  // browser saves it under a real filename instead of the object key.
  upload: function(bucketName, key, stream, contentType, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var meta = { contentType: contentType };
    if (opts.contentDisposition) meta.contentDisposition = opts.contentDisposition;
    var writeStream = getStorage().bucket(bucketName).file(key)
      .createWriteStream({ metadata: meta, resumable: false });
    writeStream.on('error', cb);
    writeStream.on('finish', function() { cb(null, {}); });
    if (Buffer.isBuffer(stream)) {
      var pass = new (require('stream').PassThrough)();
      pass.end(stream);
      pass.pipe(writeStream);
    } else {
      stream.pipe(writeStream);
    }
  },

  downloadStream: function(bucketName, key) {
    return getStorage().bucket(bucketName).file(key).createReadStream();
  },

  downloadBuffer: function(bucketName, key) {
    return getStorage().bucket(bucketName).file(key).download()
      .then(function(data) { return data[0]; });
  },

  objectSize: function(bucketName, key) {
    return getStorage().bucket(bucketName).file(key).getMetadata()
      .then(function(data) { return Number(data[0].size); });
  },

  deleteFile: function(bucketName, key, cb) {
    getStorage().bucket(bucketName).file(key).delete(cb);
  },

  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    return getStorage().bucket(bucketName).file(key).getSignedUrl({
      version: 'v4', action: 'write',
      expires: Date.now() + (ttlSeconds * 1000),
      contentType: contentType
    }).then(function(data) { return data[0]; });
  }
};
