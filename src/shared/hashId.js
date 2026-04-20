const crypto = require('crypto');

function hashId(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

module.exports = { hashId };
