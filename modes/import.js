const fs       = require('fs')
const pathUtil = require('path')
const cp       = require('child_process')
const execSync = cp.execSync
const lib      = require(__dirname + '/../lib')

function start(config, options) {
  lib.stopLauncher(config)
  // deal with existing state

  // back it up
  if (fs.existsSync(config.blockchain.beldexd_key)) {
    console.log(config.blockchain.beldexd_key, "exists, this has been run as a master node, backing up")
    execSync(config.entrypoint + ' export')
  }
  // ok clear state
  function deleteIfExists(file) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  }
  console.log('clearing mnode')
  deleteIfExists(config.blockchain.beldexd_key)
  deleteIfExists(config.blockchain.beldexd_edkey)
  deleteIfExists(config.network.data_dir + '/encryption.private')
  deleteIfExists(config.network.data_dir + '/transport.private')
  deleteIfExists(config.storage.data_dir + '/storage.db')

  // start import
  const filePath = options.srcPath
  function extractFile(file) {
    execSync('tar xvf ' + filePath + ' -C ' + pathUtil.dirname(file) + ' ' + pathUtil.basename(file))
  }
  console.log('importing blockchain keys')
  extractFile(config.blockchain.beldexd_key)
  extractFile(config.blockchain.beldexd_edkey)
  console.log('importing network keys')
  extractFile(config.network.data_dir + '/encryption.private')
  extractFile(config.network.data_dir + '/transport.private')
  console.log('importing storage data')
  extractFile(config.storage.data_dir + '/storage.db')
}

module.exports = {
  start: start,
}
