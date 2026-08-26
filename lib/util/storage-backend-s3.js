var aws    = require('../../config/aws'),
    config = require('config');

module.exports = {
  // opts is optional and may be omitted entirely: upload(b, k, s, type, cb).
  upload: function(bucketName, key, stream, contentType, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var client = new aws.S3();
    var params = { Bucket: bucketName, Key: key, Body: stream, ContentType: contentType };
    if (opts.contentDisposition) params.ContentDisposition = opts.contentDisposition;
    client.putObject(params, cb);
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

  objectSize: function(bucketName, key) {
    var client = new aws.S3();
    return new Promise(function(resolve, reject) {
      client.headObject({ Bucket: bucketName, Key: key }, function(err, data) {
        if (err) reject(err); else resolve(Number(data.ContentLength));
      });
    });
  },

  // aws-sdk v2 getSignedUrl('putObject', ...) is synchronous (same call as
  // the getObject precedent in lib/controllers/users.js) — wrap in a
  // resolved Promise so the API is promise-based on both backends.
  //
  // The browser can't resolve the internal S3 endpoint (e.g. garage:3900 /
  // minio:9000), so the URL must be signed for a browser-reachable host.
  // Under SigV4 the host is part of the signature (SignedHeaders=host), so
  // we must SIGN against the public endpoint — rewriting the host afterward
  // would invalidate the signature. Same construction as the getObject
  // precedent in lib/controllers/users.js.
  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    var client = new aws.S3(
      config.aws.publicEndpoint ? { endpoint: config.aws.publicEndpoint } : {}
    );
    return Promise.resolve(client.getSignedUrl('putObject', {
      Bucket: bucketName, Key: key, Expires: ttlSeconds, ContentType: contentType
    }));
  }
};
