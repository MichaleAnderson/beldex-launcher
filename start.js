// no npm!
const fs = require('fs')
const os = require('os')
const net = require('net')
const ini = require(__dirname + '/ini')
const lib = require(__dirname + '/lib')
const configUtil = require(__dirname + '/config')
const { spawn } = require('child_process')
//const stdin     = process.openStdin()

// to disable daemon mode for debugging
// sudo __daemon=1 node index.js

var pids = {}

function killStorageServer(config, running, pids) {
  if (config.storage.enabled && running.storageServer) {
    console.log('LAUNCHER: Killing storage on', pids.storageServer)
    process.kill(pids.storageServer, 'SIGINT')
    running.storageServer = 0
  }
}

function killBelnetAndStorageServer(config, running, pids) {
  //console.log('LAUNCHER: old network', running.belnet, pids.belnet)
  //console.log('LAUNCHER: old storage', running.storageServer, pids.storageServer)
  killStorageServer(config, running, pids)
  // FIXME: only need to restart if the key changed
  if (config.network.enabled) {
    if (running.belnet) {
      console.log('LAUNCHER: Killing belnet on', pids.belnet)
      process.kill(pids.belnet, 'SIGINT')
      running.belnet = 0
    }
  }
}

function isNothingRunning(running) {
  return !(running.beldexd || running.belnet || running.storageServer)
}

function setupBlockchainForStart(args, config) {
  // index.js does this already...
  //configUtil.check(config)

  // cli and config override ini
  /*
  var xmrOptions = configUtil.parseXmrOptions(args)
  console.log('Parsed command line options', xmrOptions)
  configUtil.loadBlockchainConfigFile(xmrOptions, config) // override any params with any config files
  */
  // combined parseXmrOptions && loadBlockchainConfigFile
  // needs data_dir configured first...
  var xmrOptions = configUtil.getOldBlockchainOptions(args, config)

  // autoconfig
  /*
  --zmq-rpc-bind-port arg (=22024, 38158 if 'testnet', 38155 if 'stagenet')
  --rpc-bind-port arg (=22023, 38157 if 'testnet', 38154 if 'stagenet')
  --p2p-bind-port arg (=22022, 38156 if 'testnet', 38153 if 'stagenet')
  --p2p-bind-port-ipv6 arg (=22022, 38156 if 'testnet', 38153 if 'stagenet')
  */
  // FIXME: map?
  if (config.blockchain.zmq_port == '0') {
    // only really need this one set for belnet
    config.blockchain.zmq_port = undefined
    /*
    if (config.blockchain.network == 'test') {
      config.blockchain.zmq_port = 38158
    } else
    if (config.blockchain.network == "staging") {
      config.blockchain.zmq_port = 38155
    } else {
      config.blockchain.zmq_port = 22024
    }
    */
  }
  if (config.blockchain.p2p_port == '0') {
    // only really need this one set for belnet
    config.blockchain.p2p_port = undefined
    /*
    if (config.blockchain.network == 'test') {
      config.blockchain.p2p_port = 38156
    } else
    if (config.blockchain.network == 'staging') {
      config.blockchain.p2p_port = 38153
    } else {
      config.blockchain.p2p_port = 22022
    }
    */
  }

  //
  // Disk Config needs to be locked by this point
  //
  configUtil.setupInitialBlockchainOptions(xmrOptions, config)

  // FIXME: convert getBeldexDataDir to internal config value
  // something like estimated/calculated beldex_data_dir
  // also this will change behavior if we actually set the CLI option to beldexd
  if (!config.blockchain.data_dir) {
    console.log('Using default data_dir, network', config.blockchain.network)
    config.blockchain.data_dir = os.homedir() + '/.beldex'
  }
  // make sure data_dir has no trailing slash
  config.blockchain.data_dir = config.blockchain.data_dir.replace(/\/$/, '')

  // handle merging remaining launcher options
  if (xmrOptions['rpc-login']) {
    if (xmrOptions['rpc-login'].match(/:/)) {
      var parts = xmrOptions['rpc-login'].split(/:/)
      var user = parts.shift()
      var pass = parts.join(':')
      config.blockchain.rpc_user = user
      config.blockchain.rpc_pass = pass
    } else {
      console.warn('Can\'t read rpc-login command line argument', xmrOptions['rpc-login'])
    }
  }
  // rpc_ip
  if (xmrOptions['rpc-bind-ip']) {
    // any way to validate this string?
    config.blockchain.rpc_ip = xmrOptions['rpc-bind-ip']
  }
  function setPort(cliKey, configKey, subsystem) {
    if (subsystem === undefined) subsystem = 'blockchain'
    //console.log('xmrOptions', xmrOptions, 'checking for', cliKey, 'setting', subsystem, configKey)
    if (xmrOptions[cliKey]) {
      var test = parseInt(xmrOptions[cliKey])
      if (test) {
        config[subsystem][configKey] = xmrOptions[cliKey]
      } else {
        console.warn('Can\'t read', cliKey, 'command line argument', xmrOptions[cliKey])
      }
    }
  }
  setPort('zmq-rpc-bind-port', 'zmq_port')
  setPort('rpc-bind-port', 'rpc_port')
  setPort('p2p-bind-port', 'p2p_port')
}

module.exports = function(args, config, entryPoint, debug) {
  const VERSION = 0.7

  //var logo = lib.getLogo('L A U N C H E R   v e r s i o n   v version')
  //console.log('beldex SN launcher version', VERSION, 'registered')
  const belnet = require(__dirname + '/belnet') // needed for checkConfig

  var requested_config = config

  setupBlockchainForStart(args, config)
  // launcher defaults were here...
  // belnet defaults were here...
  // now in config.js

  // FIXME: maybe this should be inside the belnet library...
  if (config.network.data_dir) {
    // beldexd
    //ident-privkey=/Users/admin/.belnet/identity.private
    // not beldexg
    //transport-privkey=/Users/admin/.belnet/transport.private
    //encryption-privkey=/Users/admin/.belnet/encryption.private
    config.network.transport_privkey = config.network.data_dir + '/transport.private'
    config.network.encryption_privkey = config.network.data_dir + '/encryption.private'
    config.network.ident_privkey = config.network.data_dir + '/identity.private'
    config.network.contact_file = config.network.data_dir + '/self.signed'
    if ((config.network.profiling === undefined || config.network.profiling) && config.network.profiling_file === undefined) {
      config.network.profiling_file = config.network.data_dir + '/profiles.dat'
    }
  }
  if (!configUtil.isBlockchainBinary3X && !configUtil.isBlockchainBinary4Xor5X && config.network.enabled) {
    belnet.checkConfig(config.network) // can auto-configure network.binary_path. how?
  }

  // beldexd config and most other configs should be locked into stone by this point
  // (except for belnet, since we need to copy beldexd over to it)

  console.log('Launcher running config:', config)
  /*
  var col1 = []
  var col2 = []
  for(var k in config.blockchain) {
    col1.push(k)
    col2.push(config.blockchain[k])
  }
  var col3 = []
  var col4 = []
  for(var k in config.network) {
    col3.push(k)
    col4.push(config.network[k])
  }
  var maxRows = Math.max(col1.length, col3.length)
  for(var i = 0; i < maxRows; ++i) {
    var c1 = '', c2 = '', c3 = '', c4 = ''
    if (col1[i] !== undefined) c1 = col1[i]
    if (col2[i] !== undefined) c2 = col2[i]
    if (col3[i] !== undefined) c3 = col3[i]
    if (col4[i] !== undefined) c4 = col4[i]
    var c2chars = 21
    if (c4.length > c2chars) {
      var diff = c4.length - 29 + 4 // not sure why we need + 4 here...
      var remaining = c2chars - c2.length
      //console.log('diff', diff, 'remaining', remaining)
      if (remaining > 0) {
        if (remaining >= diff) {
          c2chars -= diff
          //console.log('padding 2 to', c2chars)
        }
      }
    }
    console.log(c1.padStart(11, ' '), c2.padStart(c2chars, ' '), c3.padStart(11, ' '), c4.padStart(27, ' '))
  }
  console.log('storage config', config.storage)
  */

  // upload final beldexd to belnet
  config.network.beldexd = config.blockchain

  //
  // Config is now set in stone
  //

  //console.log(logo.replace(/version/, VERSION.toString().split('').join(' ')))


  //
  // run all sanity checks
  //

  if (!fs.existsSync(config.blockchain.binary_path)) {
    console.error('beldexd is not at configured location', config.blockchain.binary_path)
    process.exit(1)
  }
  if (config.storage.enabled) {
    if (!fs.existsSync(config.storage.binary_path)) {
      console.error('storageServer is not at configured location', config.storage.binary_path)
      process.exit(1)
    }
  }
  if (config.network.enabled) {
    if (!fs.existsSync(config.network.binary_path)) {
      console.error('belnet is not at configured location', config.network.binary_path)
      process.exit(1)
    }

    if (config.network.bootstrap_path && !fs.existsSync(config.network.bootstrap_path)) {
      console.error('belnet bootstrap not found at location', config.network.binary_path)
      process.exit(1)
    }
  }
  // isn't create until beldexd runs
  /*
  if (!fs.existsSync(config.storage.beldexd_key)) {
    console.error('beldexd key not found at location', config.storage.beldexd_key)
    process.exit()
  }
  */

  if (!config.launcher.var_path) {
    console.error('no var_path set')
    process.exit(1)
  }

  if (!fs.existsSync(config.launcher.var_path)) {
    // just make sure this directory exists
    // FIXME: maybe skip if root...
    console.log('Making', config.launcher.var_path)
    belnet.mkDirByPathSync(config.launcher.var_path)
  }

  // make sure the binary_path that exists are not a directory
  if (fs.lstatSync(config.blockchain.binary_path).isDirectory()) {
    console.error('beldexd configured location is a directory', config.blockchain.binary_path)
    process.exit(1)
  }
  if (config.storage.enabled) {
    if (fs.lstatSync(config.storage.binary_path).isDirectory()) {
      console.error('storageServer configured location is a directory', config.storage.binary_path)
      process.exit(1)
    }
  }
  if (config.network.enabled) {
    if (fs.lstatSync(config.network.binary_path).isDirectory()) {
      console.error('belnet configured location is a directory', config.network.binary_path)
      process.exit(1)
    }

    if (config.network.bootstrap_path && fs.lstatSync(config.network.bootstrap_path).isDirectory()) {
      console.error('belnet bootstrap configured location is a directory', config.network.binary_path)
      process.exit(1)
    }
  }
  if (config.storage.enabled) {
    if (fs.existsSync(config.storage.beldexd_key) && fs.lstatSync(config.storage.beldexd_key).isDirectory()) {
      console.error('beldexd key location is a directory', config.storage.beldexd_key)
      process.exit(1)
    }

    if (config.storage.data_dir !== undefined) {
      if (fs.existsSync(config.storage.data_dir)) {
        if (!fs.lstatSync(config.storage.data_dir).isDirectory()) {
          console.error('Storage server data_dir is not a directory', config.storage.data_dir)
          process.exit(1)
        } // else perfect
      } // else we'll make
    } // else we'll just current dir
  }

  //console.log('userInfo', os.userInfo('utf8'))
  //console.log('started as', process.getuid(), process.geteuid())

  // no need to double bitch
  /*
  if (os.platform() == 'darwin') {
    if (process.getuid() != 0) {
      console.error('MacOS requires you start this with sudo')
      process.exit(1)
    }
  } else {
    if (process.getuid() == 0) {
      console.error('Its not recommended you run this as root')
    }
  }
  */

  //
  // get processes state
  //

  // are we already running
  var pid = lib.areWeRunning(config)
  if (pid) {
    console.log('LAUNCHER: Beldex launcher already active under', pid)
    process.exit()
  }

  pids = lib.getPids(config)
  var running = lib.getProcessState(config)

  // progress to 2nd phase where we might need to start something
  const daemon = require(__dirname + '/daemon')
  daemon.config = config // update config for shutdownEverything

  function startEverything(config, args) {
    for (var i in args) {
      // should we prevent --non-interactive?
      // probably not, if they want to run it that way, why not support it?
      var arg = args[i]
      if (arg == '--non-interactive') {
        // inform launcher to work like they desire
        config.launcher.docker = true
      }
    }

    // to debug
    // sudo __daemon=1 node index.js
    //daemon(args, __filename, belnet, config, getBeldexDataDir)
    var foregroundIt = config.launcher.interactive || !lib.falsish(config.launcher.docker)
    //console.log('LAUNCHER: startEverything - foreground?', foregroundIt)

    //function start(config, foregroundIt, entryPoint, args) {
    daemon.startLauncherDaemon(config, foregroundIt, entryPoint, args, debug, function() {
      // should be in the daemon at this point...
      if (config.launcher.publicIPv4) {
        // manually configured
        start(config, foregroundIt, entryPoint, args)
      } else {
        // auto configure value
        belnet.getPublicIPv4(function(publicIPv4) {
          if (!publicIPv4) {
            console.error('LAUNCHER: Could not determine a IPv4 public address for this host.')
            process.exit()
          }
          config.launcher.publicIPv4 = publicIPv4
          start(config, foregroundIt, entryPoint, args)
        })
      }

      function start(config, args) {
        // start the belnet prep
        daemon.startBelnet(config, args, function(started) {
          //console.log('StorageServer now running', started)
          if (!started) {
            daemon.shutdown_everything()
          }
        })
        daemon.startBeldexd(config, args)
      }
    })
  }

  //
  // normalize state
  //

  // kill what needs to be killed

  // storage needs it's belnet, kill any strays
  if (config.network.enabled && config.storage.enabled) {
    // FIXME: clearnet support?
    if (!running.belnet && running.storageServer) {
      console.log('LAUNCHER: We have storage server with no belnet, killing it.', pids.storageServer)
      process.kill(pids.storageServer, 'SIGINT')
      running.storageServer = 0
    }
    // FIXME if just blockchain and storage server, should we restart the storage if beldexd dies?
  }

  if (!config.network.enabled && config.storage.enabled && !running.beldexd) {
    // clearnet mode (blockchain and storage)
    // no need to kill storage server
    // Maxim confirmed
  }

  if (config.network.enabled && !running.beldexd) {
    // no beldexd, kill remaining
    //console.log('LAUNCHER: beldexd is down, kill idlers.')
    killBelnetAndStorageServer(config, running, pids)
  }

  if (!pids.beldex) {
    // no pid on disk or it's running
    var useConfig = config
    if (pids.runningConfig) useConfig = pids.runningConfig
    belnet.portIsFree(useConfig.blockchain.rpc_ip, useConfig.blockchain.rpc_port, function(portFree) {
      console.log('rpc:', useConfig.blockchain.rpc_ip + ':' + useConfig.blockchain.rpc_port, 'status', portFree?'not running':'running')
      if (!portFree) {
        console.log('')
        console.log('There\'s a beldexd that we\'re not tracking using our configuration (rpc_port is already in use). You likely will want to confirm and manually stop it before start using the launcher again. Exiting...')
        console.log('')
        // no pids.json will exist... and not easy to fake one
        daemon.shutdown_everything()
      } else {
        // port is open
        if (isNothingRunning(running)) {
          console.log("LAUNCHER: Starting fresh copy of Beldex Suite.")
          startEverything(config, args)
          return
        }
        // we can't go into recovery mode if there's no beldexd
      }
    })
    return
  }
  if (isNothingRunning(running)) {
    console.log("LAUNCHER: Starting fresh copy of Beldex Suite.")
    startEverything(config, args)
    return
  }

  //
  // go into recovery mode
  //

  // ignore any configuration of current
  if (pids.config) {
    //console.log('replacing config with running config', pids.config)
    config = pids.config
    args = pids.args
  }

  // adopt responsibility of watching the existing suite
  function launcherRecoveryMonitor(config) {
    var pids = lib.getPids(config)

    // concern: what if it's running but quitting
    // our timer will catch this
    // concern: what if belnet/storage is restarted elsewhere
    // it won't because we've already ensured we're the only launcher for this
    if (!pids.beldexd || !lib.isPidRunning(pids.beldexd)) {
      if (pids.beldexd) {
        console.log('LAUNCHER: beldexd just died.', pids.beldexd)
      } else {
        // pids file was just cleared...
      }
      // no launcher, so we may need to do someclean up
      // beldexd needs no clean up
      // kill storageServer and belnet?
      // FIXME: only need to if key changes...
      //
      // if existed previous / if we started them
      // we can't make a pids into the started style
      // so we'll have to just update from disk
      //pids = lib.getPids(config)
      running = lib.getProcessState(config)   // update locations of belnet/storageServer
      killBelnetAndStorageServer(config, running, pids) // kill them
      // and restart it all?
      if (config.blockchain.restart) {
        startEverything(config, args)
      } else {
        // so we don't want to restart beldexd but we can't find that it is running
        // but all we really know is we stopped tracking the pid
        // ctrl-c could have cleared it...
        // shutdown the launcher properly
        daemon.shutdown_everything()
      }
    } else {
      console.log('RECOVERY: Waiting for beldex key at', config.storage.beldexd_key)
      waitForBeldexKey(config, 30 * 1000, undefined, function(haveKey) {
        if (!haveKey) {
          console.error('DAEMON: Timeout waiting for beldex key.')
          // FIXME: what do?
          return
        }
        console.log('RECOVERY: Got beldex key!')
        //console.log('watching beldexd, will reclaim control when it restarts')
        if (config.network.enabled && config.storage.enabled) {
          if (!pids.belnet || !lib.isPidRunning(pids.belnet)) {
            // kill storage server
            killStorageServer(config, running, pids)
            // well assuming old beldexd is still running
            daemon.startBelnet(config, shutdownIfNotStarted)
          } else
            if (!pids.storageServer ||!lib.isPidRunning(pids.storageServer)) {
              daemon.startStorageServer(config, args, shutdownIfNotStarted)
            }
        } else if (config.storage.enabled) {
          if (!pids.storageServer ||!lib.isPidRunning(pids.storageServer)) {
            daemon.startStorageServer(config, args, shutdownIfNotStarted)
          }
        } else if (config.network.enabled) {
          if (!pids.belnet || !lib.isPidRunning(pids.belnet)) {
            // kill storage server
            killStorageServer(config, running, pids)
            // well assuming old beldexd is still running
            daemon.startBelnet(config, shutdownIfNotStarted)
          }
        }
      })
    }
    // as long as there's something to monitor
    if (pids.beldexd || pids.belnet || pids.storageServer) {
      setTimeout(function() {
        launcherRecoveryMonitor(config)
      }, 15 * 1000)
    }
    // otherwise let go of the last handle so we can exit...
  }

  function shutdownIfNotStarted(started) {
    if (!started) {
      daemon.shutdown_everything()
    }
  }

  console.log('RECOVERY: Waiting for beldex key at', config.storage.beldexd_key)
  waitForBeldexKey(config, 30 * 1000, undefined, function(haveKey) {
    if (!haveKey) {
      console.error('DAEMON: Timeout waiting for beldex key.')
      // FIXME: what do?
      return
    }
    console.log('RECOVERY: Got beldex key!')

    // figure out how to recover state with a running beldexd
    if (config.network.enabled && !running.belnet) {
      // start belnet
      // therefore starting storageServer
      daemon.startBelnet(config, args, shutdownIfNotStarted)
    } else
      if (config.storage.enabled && !running.storageServer) {
        // start storageServer
        daemon.startStorageServer(config, args, shutdownIfNotStarted)
      }

  })
  // we need start watching everything all over again
  launcherRecoveryMonitor(config)

  // well now register ourselves as the proper guardian of the suite
  lib.setStartupLock(config)

  // handle handlers...
  daemon.setupHandlers()

  // so we won't have a console for the socket to connect to
  // should we run an empty server and let them know?
  // well we can only send a message and we can do that on the client side
}
