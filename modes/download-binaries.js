const fs = require('fs')
const os = require('os')
const http  = require('http')
const https = require('https')
const urlparser = require('url')
const pathUtil  = require('path')
const lib       = require(__dirname + '/../lib')
const belnet   = require(__dirname + '/../belnet')
//const configUtil = require(__dirname + '/../config')

const debug = false

// we need this for github header
const VERSION = 0.3
//console.log('beldex binary downloader version', VERSION, 'registered')

let xenial_hack = false

function getFileSizeSync(path) {
  const stats = fs.statSync(path)
  return stats.size
}

function downloadGithubFile(dest, url, cb) {

  const urlDetails = urlparser.parse(url)
  //console.log('httpGet url', urlDetails)
  //console.log('httpGet', url)
  var protoClient = http
  if (urlDetails.protocol == 'https:') {
    protoClient = https
  }
  // well somehow this can get hung on macos
  var abort = false
  var watchdog = setInterval(function () {
    if (shuttingDown) {
      //if (cb) cb()
      // [', url, ']
      console.log('hung httpGet but have shutdown request, calling back early and setting abort flag')
      clearInterval(watchdog)
      abort = true
      cb(false)
      return
    }
  }, 2 * 60 * 60 * 1000)
  protoClient.get({
    hostname: urlDetails.hostname,
    protocol: urlDetails.protocol,
    port: urlDetails.port,
    path: urlDetails.path,
    timeout: 5000,
    headers: {
      'User-Agent': 'Mozilla/5.0 Beldex-launcher/' + VERSION
    }
  }, (resp) => {
    //log('httpGet setting up handlers')
    clearInterval(watchdog)
    if (resp.statusCode === 302 || resp.statusCode === 301) {
      if (debug) console.debug('Got redirect to', resp.headers.location)
      downloadGithubFile(dest, resp.headers.location, cb)
      return
    }
    var file = fs.createWriteStream(dest, { encoding: 'binary' })
    resp.setEncoding('binary')
    const len = parseInt(resp.headers['content-length'], 10)
    var downloaded = 0
    var lastPer = 0
    resp.on('data', function(chunk) {
      downloaded += chunk.length
      var tenPer = parseInt(10 * downloaded / len, 10)
      //console.log('tenper', tenper, downloaded / len)
      if (tenPer != lastPer) {
        var haveMBs = downloaded / (1024 * 1024)
        var totalMBs = len / (1024 * 1024)
        console.log('Downloaded', (tenPer * 10) + '%', haveMBs.toFixed(2) + '/' + totalMBs.toFixed(2) +'MBi')
        lastPer = tenPer
      }
    })
    resp.pipe(file)
    file.on('finish', function() {
      //console.log('File download ', downloaded, '/', len, 'bytes of', url, 'complete')
      if (downloaded < len) {
        console.warn('file is incomplete, please try again later...')
        fs.unlinkSync(dest)
        process.exit(1)
      }
      file.close(cb)
    })
  }).on("error", (err) => {
    console.error("downloadFile Error: " + err.message, 'port', urlDetails.port)
    //console.log('err', err)
    cb()
  })
}

function downloadArchive(url, config, options) {
  var ext = options.ext
  const baseArchDir = pathUtil.basename(url, ext)
  var filename = options.filename
  console.log('Downloading', filename, 'binaries from', url)
  console.log('')
  var tmpPath = '/tmp/beldex-launcher_binaryDownload-' + belnet.randomString(8) + ext
  //console.log('downloading to tmp file', tmpPath)
  downloadGithubFile(tmpPath, url, function(result) {
    if (result !== undefined) {
      console.log('something went wrong with download, try again later or check with us')
      process.exit(1)
    }
    //console.log('result is', result)
    var searchRE = new RegExp(ext, 'i')
    if (url.match(searchRE)) {
      const { exec } = require('child_process')

      /*
      function waitForBinaryToBeDeadAndExtract() {
        running = lib.getProcessState(config)
        function waitAndRetry() {
          console.log('waiting 5s for ' + filename + ' to quit...')
          setTimeout(waitForBinaryToBeDeadAndExtract, 5000)
        }
        if (filename == 'beldexd') {
          if (running.beldexd) {
            return waitAndRetry()
          }
        } else if (filename == 'beldex-storage') {
          if (running.storageServer) {
            return waitAndRetry()
          }
        }
      }
      */

      lib.waitForLauncherStop(config, function() {
        //waitForBinaryToBeDeadAndExtract()
        var extractPath = '--strip-components=1 ' + baseArchDir + '/' + filename
        if (options.useDir === false) {
          extractPath = filename
        }
        var commandLine = 'tar xvf '+tmpPath+' -C /opt/beldex-launcher/bin '+extractPath
        console.log('Untarring')
        // FIXME: linux can't extract zips like this (but macos can)
        exec(commandLine, (err, stdout, stderr) => {
          // delete tmp file
          if (1) {
            //console.debug('cleaning up', tmpPath)
            fs.unlinkSync(tmpPath)
          }
          if (err) {
            console.error('file extract error', err)
            return
          }
          //console.log('stdout', stdout)
          //console.log('stderr', stderr)
          //console.log('Untar Success')
          console.log(filename, 'successfully extracted to /opt/beldex-launcher/bin', getFileSizeSync('/opt/beldex-launcher/bin/' + filename), 'bytes extracted.')
          console.log('Running version check..')
          var option = '-version'
          if (filename == 'beldex-storage') {
            option = 'v'
          }
          exec('/opt/beldex-launcher/bin/' + filename + ' -' + option, (err, stdout, stderr) => {
            console.log(filename, stdout)
            if (options.cb) {
              options.cb(true)
            }
          })
        })


      })
    } else {
      console.log('URL', url, 'does not contain .tar.xz')
    }
  })
}

async function downloadGithubRepo(github_url, options, config, curVerStr, cb) {
  belnet.httpGet(github_url, function(json) {
    //console.log('got', github_url, 'result', json)
    if (json === undefined) {
      // possibly a 403
      start_retries++
      // 20 * 2m = 40m
      if (start_retries < 20) {
        setTimeout(function() {
          console.log('retrying...')
          downloadGithubRepo(github_url, options, config, cb)
        }, 120 * 1000)
      } else {
        console.warn('failure communicating with api.github.com')
      }
      return
    }
    try {
      var data = JSON.parse(json)
    } catch(e) {
      console.debug('json', json)
      console.error('error with', github_url, e)
      process.exit(1)
    }

    // console.log('downloadGithubRepo options', options)

    if (data.length) {
      //console.log('Got a list of', data.length, 'releases, narrowing it down.')
      var selectedVersion = null
      for(var i in data) {
        const ver = data[i]

        // skip if name is in the skip list
        if (options.skips) {
          if (options.skips.indexOf(ver.name) !== -1) {
            continue
          }
        }

        if (options.prereleaseOnly) {
          if (ver.prerelease) {
            selectedVersion = ver
            break
          }
        } else {
          if (options.notPrerelease) {
            if (!ver.prerelease) {
              selectedVersion = ver
              break
            }
          } else {
            // not prereleaseOnly and not notPrerelease
            // just download the first
            selectedVersion = ver
            break
          }
        }
      }
      if (selectedVersion === null) {
        console.error('Could not find latest release from a list of', data.length)
        if (options.prereleaseOnly) console.log('prerelease only mode')
        if (options.notPrerelease) console.log('release only Mode')
        process.exit(1)
      }
      data = selectedVersion
      console.log('selecting', data.name)
    }

    // definitely broken for RCs...
    if (!config.forceDownload) {
      // since there's no commit rev in the data
      // FIXME: compare created_at / published_at against our dates
      // our dates should be newer
      //console.log('data', data)
      // tag_name, name
      var thisVer = data.tag_name.replace(/^v/, '')
      //console.log('looking at version', thisVer, '==', curVerStr)
      if (curVerStr && curVerStr.match && curVerStr.match(thisVer)) {
        console.log('seems', thisVer, 'is the latest and you have', curVerStr + '! skipping')
        // no one reads the return code
        // but lets stay consistent
        return cb(true)
      }
    }

    var search = 'UNKNOWN'
    if (os.platform() == 'darwin') search = 'osx'
    else
    if (os.platform() == 'linux') search = 'linux'
    else {
      console.error('Sorry, platform', os.platform(), 'is not currently supported, please let us know you would like us to support this platform by opening an issue on github: https://github.com/beldex-project/beldex-launcher/issues')
      process.exit(1)
    }
    var platform = new RegExp(process.arch, 'i')
    var searchRE = new RegExp(search, 'i')
    var found = false // we only need one archive for our platform and we'll figure it out
    // FIXME do a final version check
    options.cb = cb
    for(var i in data.assets) {
      var asset = data.assets[i]
      //console.log(i, 'asset', asset.browser_download_url)
      if (search == 'linux' && asset.browser_download_url.match(searchRE) && asset.browser_download_url.match(/\.tar.xz/i) && asset.browser_download_url.match(/-x64-/i)) {
        // linux
        options.ext = '.tar.xz'
        downloadArchive(asset.browser_download_url, config, options)
        found = true
      }
      // storage server support
      if (search == 'osx' && asset.browser_download_url.match(searchRE) && asset.browser_download_url.match(/\.tar.xz/i) && asset.browser_download_url.match(/-x64-/i)) {
        // MacOS
        if (!found) {
          options.ext = '.tar.xz'
          downloadArchive(asset.browser_download_url, config, options)
          found = true
        }
      } else
      if (search == 'osx' && asset.browser_download_url.match(searchRE) && asset.browser_download_url.match(/\.zip/i) && asset.browser_download_url.match(/-x64-/i)) {
        // MacOS
        if (!found) {
          options.ext = '.zip'
          downloadArchive(asset.browser_download_url, config, options)
          found = true
        }
      }
    }
    if (!found) {
      if (options.skips === undefined) options.skips = []
      options.skips.push(data.name)
      console.log('No binary found for', search, 'for', data.name, 'searching for older version (that is not:', options.skips, ')')

      // add timeout to not flood github
      setTimeout(function() {
        downloadGithubRepo(github_url, options, config, curVerStr, cb)
      }, 5000 * options.skips.length)
    }
  })
}

// FIXME: move into options
var start_retries = 0
function start(config, options) {
  /*
  const { exec } = require('child_process')
  exec('lsb_release -c', (err, stdout, stderr) => {
    //console.log(stdout)
    if (stdout && stdout.match(/xenial/)) {
      xenial_hack = true
    }
  })
  */
  // quick request so should be down by the time the file downloads...
  lib.stopLauncher(config)
  /*
  var running = lib.getProcessState(config)
  if (running.beldexd) {
    var pids = lib.getPids(config)
    console.log('beldexd is running, request shutdown')
    process.kill(pids.beldexd, 'SIGINT')
    // should be down by the time the file downloads...
  }
  */
  // deb support? nope, you use apt to update...
  // FIXME: this force sudo support...
  belnet.mkDirByPathSync('/opt/beldex-launcher/bin')
  console.log('Configured architecture:', process.arch)
  return new Promise(resolve => {

    // can't get draft release without authenticating as someone that can see the draft...

    if (options.forceDownload) {
      config.forceDownload = options.forceDownload
    }
    baseOptions = {}
    baseOptions[options.prerel ? 'prereleaseOnly': 'notPrerelease'] = true

    if (config.blockchain.network == 'test' || config.blockchain.network == 'demo' || config.blockchain.network == 'staging') {
      downloadGithubRepo('https://api.github.com/repos/beldex-project/belnet/releases', { filename: 'belnet', useDir: true, ...baseOptions }, config, lib.getNetworkVersion(config), function() {
        start_retries = 0
        belnet.checkConfig(config) // setcap
        downloadGithubRepo('https://api.github.com/repos/beldex-project/beldex-storage-server/releases', { filename: 'beldex-storage', useDir: false, ...baseOptions }, config, lib.getStorageVersion(config), function() {
          start_retries = 0
          downloadGithubRepo('https://api.github.com/repos/beldex-project/beldex-core/releases', { filename: 'beldexd', useDir: true, ...baseOptions }, config, lib.getBlockchainVersion(config), function() {
            resolve()
          })
        })
      })
    } else {
      downloadGithubRepo('https://api.github.com/repos/beldex-project/belnet/releases', { filename: 'belnet', useDir: true, ...baseOptions }, config, lib.getNetworkVersion(config), function() {
        start_retries = 0
        belnet.checkConfig(config) // setcap
        downloadGithubRepo('https://api.github.com/repos/beldex-project/beldex-storage-server/releases', { filename: 'beldex-storage', useDir: false, ...baseOptions }, config, lib.getStorageVersion(config), function() {
          start_retries = 0
          /*
          if (xenial_hack) {
            console.log('Detected Xenial, forcing 4.0.5. This is temporary, until 5.1.0 supports your operating system version')
            downloadGithubRepo('https://api.github.com/repos/beldex-project/beldex/releases/19352901', { filename: 'beldexd', useDir: true, notPrerelease: true }, config)
          } else {
          */
          downloadGithubRepo('https://api.github.com/repos/beldex-project/beldex-core/releases', { filename: 'beldexd', useDir: true, ...baseOptions }, config, lib.getBlockchainVersion(config), function() {
            // can't run fix-perms without knowing the user
            resolve()
          })
          //}
        })
      })
    }
  })
}

module.exports = {
  start: start,
}
