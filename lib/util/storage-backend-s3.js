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

  // Read counterpart of signUploadUrl. Same public-endpoint reasoning as the
  // upload signer below: under SigV4 the host is part of the signature, so we
  // sign against the browser-reachable endpoint rather than rewriting the host
  // afterwards.
  signDownloadUrl: function(bucketName, key, ttlSeconds) {
    var client = new aws.S3(
      config.aws.publicEndpoint ? { endpoint: config.aws.publicEndpoint } : {}
    );
    var url = client.getSignedUrl('getObject', {
      Bucket: bucketName, Key: key, Expires: ttlSeconds
    });

    // Legacy fallback for SigV2 backends (e.g. older MinIO setups), whose query
    // URLs don't sign the host so a post-hoc host swap is safe. With SigV4 +
    // publicEndpoint this is unused; harmless if S3_PUBLIC_HOST is unset.
    // Carried over verbatim from lib/controllers/users.js, which is where this
    // lived before downloads moved behind the backend abstraction — it is an
    // env-only knob with no other reference in the tree, so a deploy could be
    // relying on it without anything here saying so.
    if (!config.aws.publicEndpoint && process.env.S3_PUBLIC_HOST) {
      url = url.replace(/^(https?:\/\/)[^/]+/, '$1' + process.env.S3_PUBLIC_HOST);
    }

    return Promise.resolve(url);
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
