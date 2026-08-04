var aws = require('../../config/aws');

module.exports = {
  upload: function(bucketName, key, stream, contentType, cb) {
    var client = new aws.S3();
    client.putObject({ Bucket: bucketName, Key: key, Body: stream, ContentType: contentType }, cb);
  },

  downloadStream: function(bucketName, key) {
    var client = new aws.S3();
    return client.getObject({ Bucket: bucketName, Key: key }).createReadStream();
  },

  downloadBuffer: function(bucketName, key) {
    var client = new aws.S3();
    return new Promise(function(resolve, reject) {
      client.getObject({ Bucket: bucketName, Key: key }, function(err, data) {
        if (err) reject(err); else resolve(data.Body);
      });
    });
  },

  deleteFile: function(bucketName, key, cb) {
    var client = new aws.S3();
    client.deleteObject({ Bucket: bucketName, Key: key }, cb);
  },

  // aws-sdk v2 getSignedUrl('putObject', ...) is synchronous (same call as
  // the getObject precedent in lib/controllers/users.js) — wrap in a
  // resolved Promise so the API is promise-based on both backends.
  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    var client = new aws.S3();
    return Promise.resolve(client.getSignedUrl('putObject', {
      Bucket: bucketName, Key: key, Expires: ttlSeconds, ContentType: contentType
    }));
  }
};
