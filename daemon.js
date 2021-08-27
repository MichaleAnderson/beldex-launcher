// no npm!
const fs = require('fs')
const os = require('os')
const net = require('net')
const dns = require('dns')
const path = require('path')
const lib = require(__dirname + '/lib')
const belnet = require(__dirname + '/belnet')
const configUtil = require(__dirname + '/config')
const networkTest = require(__dirname + '/lib.networkTest')
const cp  = require('child_process')
const spawn = cp.spawn
const execSync = cp.execSync
const stdin = process.openStdin()

//const longjohn = require('longjohn')

const VERSION = 0.2
//console.log('beldex daemon library version', VERSION, 'registered')

let g_config = false
let server = false
let webApiServer = false
process.on('uncaughtException', function (err) {
  console.trace('Caught exception:', err)
  let var_path = '/tmp'
  if (g_config) var_path = g_config.launcher.var_path
  fs.appendFileSync(var_path + '/launcher_exception.log', JSON.stringify({
    err: err,
    code: err.code,
    msg: err.message,
    trace: err.stack.split("\n")
  }) + "\n")
  // if we're in cimode, throw up red flag
  if (savePidConfig.config && savePidConfig.config.launcher.cimode) {
    process.exit(1)
  }
})

let connections = []
function disconnectAllClients() {
  console.log('SOCKET: Disconnecting all', connections.length, 'clients.')
  for(let i in connections) {
    const conn = connections[i]
    if (!conn.destroyed) {
      //console.log('disconnecting client #'+i)
      conn.destroy()
    }
  }
  connections = [] // clear them
}

// lower permissions and run cb
// don't use this for belnet on MacOS
function lowerPermissions(user, cb) {
  process.setuid(user)
}

function blockchain_running() {
  return beldex_daemon && beldex_daemon.pid && lib.isPidRunning(beldex_daemon.pid)
}
function storage_running() {
  return storageServer && storageServer.pid && lib.isPidRunning(storageServer.pid)
}
function network_running() {
  let belnetState = belnet.isRunning()
  return belnetState && belnetState.pid && lib.isPidRunning(belnetState.pid)
}

function waitfor_blockchain_shutdown(cb) {
  setTimeout(function() {
    if (!blockchain_running()) {
      cb()
    } else {
      waitfor_blockchain_shutdown(cb)
    }
  }, 1000)
}

function shutdown_blockchain() {
  if (beldex_daemon) {
    if (beldex_daemon.outputFlushTimer) {
      clearInterval(beldex_daemon.outputFlushTimer)
      beldex_daemon.outputFlushTimer = null
    }
  }
  if (beldex_daemon && !beldex_daemon.killed) {
    console.log('LAUNCHER: Requesting beldexd be shutdown.', beldex_daemon.pid)
    try {
      process.kill(beldex_daemon.pid, 'SIGINT')
    } catch(e) {
    }
    beldex_daemon.killed = true
  }
}

function shutdown_storage() {
  if (storageServer && !storageServer.killed) {
    // FIXME: was killed not set?
    try {
      // if this pid isn't running we crash
      if (lib.isPidRunning(storageServer.pid)) {
        console.log('LAUNCHER: Requesting storageServer be shutdown.', storageServer.pid)
        process.kill(storageServer.pid, 'SIGINT')
      } else {
        console.log('LAUNCHER: ', storageServer.pid, 'is not running')
      }
    } catch(e) {
    }
    // mark that we've tried
    storageServer.killed = true
    // can't null it if we're using killed property
    //storageServer = null
  }
}

let shuttingDown = false
let exitRequested = false
let shutDownTimer = null
let belnetPidwatcher = false
function shutdown_everything() {
  //console.log('shutdown_everything()!')
  //console.trace('shutdown_everything()!')
  if (belnetPidwatcher !== false) {
    clearInterval(belnetPidwatcher)
    belnetPidwatcher = false
  }
  shuttingDown = true
  stdin.pause()
  shutdown_storage()
  // even if not running, yet, stop any attempts at starting it too
  belnet.stop()
  lib.stop()
  shutdown_blockchain()
  // clear our start up lock (if needed, will crash if not there)
  lib.clearStartupLock(module.exports.config)
  // FIXME: should we be savings pids as we shutdown? probably

  // only set this timer once... (and we'll shut ourselves down)
  if (shutDownTimer === null) {
    shutDownTimer = setInterval(function () {
      let stop = true
      if (storage_running()) {
        console.log('LAUNCHER: Storage server still running.')
        stop = false
      }
      if (beldex_daemon) {
        if (beldex_daemon.outputFlushTimer) {
          console.log('Should never hit me')
          // clearInterval(beldex_daemon.outputFlushTimer)
          // beldex_daemon.outputFlushTimer = null
        }
      }
      if (blockchain_running()) {
        console.log('LAUNCHER: beldexd still running.')
        // beldexd on macos may need a kill -9 after a couple failed 15
        // lets say 50s of not stopping -15 then wait 30s if still run -9
        stop = false
      } else {
        if (server) {
          console.log('SOCKET: Closing socket server.')
          disconnectAllClients()
          server.close()
          server.unref()
          if (fs.existsSync(module.exports.config.launcher.var_path + '/launcher.socket')) {
            console.log('SOCKET: Cleaning socket.')
            fs.unlinkSync(module.exports.config.launcher.var_path + '/launcher.socket')
          }
          server = false
        }
      }
      const belnetState = belnet.isRunning()
      if (network_running()) {
        console.log('LAUNCHER: belnet still running.')
        stop = false
      }
      if (stop) {
        if (webApiServer) {
          webApiServer.close()
          webApiServer.unref()
          webApiServer = false
        }
        console.log('All daemons down.')
        // deallocate
        // can't null these yet because beldexd.onExit
        // race between the pid dying and registering of the exit
        storageServer = null
        beldex_daemon = null
        // FIXME: make sure belnet.js handles this
        // belnetState = null
        lib.clearPids(module.exports.config)
        /*
        if (fs.existsSync(config.launcher.var_path + '/pids.json')) {
          console.log('LAUNCHER: clearing pids.json')
          fs.unlinkSync(config.launcher.var_path + '/pids.json')
        } else {
          console.log('LAUNCHER: NO pids.json found, can\'t clear')
        }
        */
        clearInterval(shutDownTimer)
        // docker/node 10 on linux has issue with this
        // 10.15 on macos has a handle, probably best to release
        if (stdin.unref) {
          //console.log('unref stdin')
          stdin.unref()
        }
        // if belnet wasn't started yet, due to slow net/dns stuff
        // then it'll take a long time for a timeout to happen
        // 2 writes, 1 read
        /*
        var handles = process._getActiveHandles()
        console.log('handles', handles.length)
        for(var i in handles) {
          var handle = handles[i]
          console.log(i, 'type', handle._type)
        }
        console.log('requests', process._getActiveRequests().length)
        */
      }
    }, 5000)
  }

  // don't think we need, seems to handle itself
  //console.log('should exit?')
  //process.exit()
}

let storageServer
var storageLogging = true
// you get one per sec... so how many seconds to do you give beldexd to recover?
// you don't get one per sec
// 120s
// it's one every 36 seconds
// so lets say 360 = 10
var lastBeldexdContactFailures = []
function launcherStorageServer(config, args, cb) {
  if (shuttingDown) {
    //if (cb) cb()
    console.log('STORAGE: Not going to start storageServer, shutting down.')
    return
  }
  // no longer true
  /*
  if (!config.storage.beldexd_key) {
    console.error('storageServer requires beldexd_key to be configured.')
    if (cb) cb(false)
    return
  }
  */

  // set storage port default
  if (!config.storage.port) {
    config.storage.port = 8080
  }
  // configure command line parameters
  const optionals = []
  const requireds = []
  if (config.storage.testnet) {
    optionals.push('--testnet')
  }
  if (config.storage.log_level) {
    optionals.push('--log-level', config.storage.log_level)
  }
  if (config.storage.data_dir) {
    optionals.push('--data-dir', config.storage.data_dir)
  }
  if (config.storage.beldexd_rpc_port) {
    optionals.push('--beldexd-rpc-port', config.storage.beldexd_rpc_port)
  }
  if (!configUtil.isStorageBinary2X(config)) {
    // 1.0.x
    // this was required, we'll stop supporting it in 2x (tho 2.0 still accepts it)
    if (config.storage.beldexd_key) {
      optionals.push('--beldexd-key', config.storage.beldexd_key)
    }
  } else {
    // 2.x
    requireds.push('--lmq-port', config.storage.lmq_port)
  }
  if (config.storage.force_start) {
    optionals.push('--force-start')
  }
  console.log('STORAGE: Launching', config.storage.binary_path, [config.storage.ip, config.storage.port, ...requireds, ...optionals].join(' '))
  /*
  // ip and port must be first
  var p1 = '"' + (['ulimit', '-n', '16384 ; ', config.storage.binary_path, config.storage.ip, config.storage.port, ...requireds, ...optionals].join(' ')) + '"'
  console.log('p1', p1)
  storageServer = spawn('/bin/bash', ['-c', p1], {
  })
  */
  storageServer = spawn(config.storage.binary_path, [config.storage.ip, config.storage.port, ...requireds, ...optionals])

  //storageServer = spawn('/usr/bin/valgrind', ['--leak-check=yes', config.storage.binary_path, config.storage.ip, config.storage.port, '--log-level=trace', ...optionals])
  // , { stdio: 'inherit' })

  //console.log('storageServer', storageServer)
  if (!storageServer.stdout || !storageServer.pid) {
    console.error('storageServer failed?')
    if (cb) cb(false)
    return
  }
  storageServer.killed = false
  storageServer.startTime = Date.now()
  storageServer.blockchainFailures = {}
  lib.savePids(config, args, beldex_daemon, belnet, storageServer)

  function getPidLimit(pid) {
    // linux only
    try {
      const currentLimit = execSync(`grep 'open file' /proc/${pid}/limits`)
      const lines = currentLimit.toString().split('\n')
      const parts = lines[0].split(/\s{2,}/)
      //console.log('lines', lines)
      //console.log('parts', parts)
      return [ parts[1], parts[2]]
    } catch(e) {
      console.error('getPidLimit error', e.code, e.message)
      return [ 0, 0 ]
    }
  }


  if (configUtil.isStorageBinary2X(config)) {
    var limits = getPidLimit(storageServer.pid)
    if (limits[0] < 16384 || limits[1] < 16384) {
      console.error('')
      var ourlimits = getPidLimit(process.pid)
      console.warn('')
      console.warn('node limits', ourlimits, 'beldex-storage limits', limits)
      console.warn('There maybe not enough file descriptors to run beldex-storage, you may want to look at increasing it')
      console.warn('')
      // console.error('Not enough file descriptors to run beldex-storage, shutting down')
      // console.error("put LimitNOFILE=16384 in your [Service] section of /etc/systemd/system/beldexd.service")
      // shutdown_everything()
    }
  }

  //var fixResult = execSync(`prlimit --pid ${storageServer.pid} --nofile=16384:16384`)
  //var fixResult = execSync(`python3 -c "import resource; resource.prlimit(${storageServer.pid}, resource.RLIMIT_NOFILE, (2048, 16384))"`)
  //console.log('fixResult', fixResult.toString())

  //console.log('after', getPidLimit())

  // copy the output to stdout
  let storageServer_version = 'unknown'
  let stdout = '', stderr = '', collectData = true
  let probablySyncing = false
  storageServer.stdout
    .on('data', (data) => {
      const logLinesStr = data.toString('utf8').trim()
      if (collectData) {
        const lines = logLinesStr.split(/\n/)
        for(let i in lines) {
          const tline = lines[i].trim()
          if (tline.match('Beldex Storage Server v')) {
            const parts = tline.split('Beldex Storage Server v')
            storageServer_version = parts[1]
          }
          if (tline.match('git commit hash: ')) {
            const parts = tline.split('git commit hash: ')
            fs.writeFileSync(config.launcher.var_path + '/storageServer.version', storageServer_version+"\n"+parts[1])
          }
          if (tline.match(/pubkey_x25519_hex is missing from sn info/)) {
            // it's be nice to know beldexd was syncing
            // but from the beldex-storage logs doesn't look like it's possible to tell
            // save some logging space
            continue
          }
          if (storageLogging) console.log(`STORAGE(Start): ${tline}`)
        }
        stdout += data
      } else {


        const lines = logLinesStr.split(/\n/)
        for(let i in lines) {
          const str = lines[i].trim()
          let outputError = true

          // all that don't need storageServer set

          // could be testing a remote node
          if (str.match(/Could not report node status: bad json in response/)) {
          } else if (str.match(/Could not report node status/)) {
          }
          if (str.match(/Empty body on Beldexd report node status/)) {
          }
          // end remote node

          if (!storageServer) {
            if (storageLogging && outputError) console.log(`STORAGE: ${logLinesStr}`)
            console.log('storageServer is unset, yet getting output', logLinesStr)
            continue
          }
          // all that need storageServer set

          // blockchain test
          if (str.match(/Could not send blockchain request to Beldexd/)) {
            if (storageLogging) console.log(`STORAGE: blockchain test failure`)
            storageServer.blockchainFailures.last_blockchain_test = Date.now()
            //communicate this out
            lib.savePids(config, args, beldex_daemon, belnet, storageServer)
          }
          // blockchain ping
          if (str.match(/Empty body on Beldexd ping/) || str.match(/Could not ping Beldexd. Status: {}/) ||
              str.match(/Could not ping Beldexd: bad json in response/) || str.match(/Could not ping Beldexd/)) {
            if (storageLogging) console.log(`STORAGE: blockchain ping failure`)
            storageServer.blockchainFailures.last_blockchain_ping = Date.now()
            //communicate this out
            lib.savePids(config, args, beldex_daemon, belnet, storageServer)
          }
          // probably syncing
          if (str.match(/Bad beldexd rpc response: invalid json fields/)) {
            probablySyncing = true
          }

          if (str.match(/pubkey_x25519_hex is missing from sn info/)) {
            // it's be nice to know beldexd was syncing
            // but from the beldex-storage logs doesn't look like it's possible to tell
            // save some logging space
            outputError = false // hide these
            continue // no need to output it again
          }

          // swarm_tick communication error
          // but happens when beldexd is syncing, so we can't restart beldexd
          if (str.match(/Exception caught on swarm update: Failed to parse swarm update/)) {
            if (probablySyncing) {
              if (storageLogging) console.log(`STORAGE: blockchain comms failure, probably syncing`)
              outputError = false // hide these
              continue // no need to output it again
            } else {
              if (storageLogging) console.log(`STORAGE: blockchain tick failure`)
              storageServer.blockchainFailures.last_blockchain_tick = Date.now()
              //communicate this out
              lib.savePids(config, args, beldex_daemon, belnet, storageServer)
            }
          } else if (str.match(/Exception caught on swarm update/)) {
            if (storageLogging) console.log(`STORAGE: blockchain tick failure. Maybe syncing? ${probablySyncing}`)
            storageServer.blockchainFailures.last_blockchain_tick = Date.now()
            //communicate this out
            lib.savePids(config, args, beldex_daemon, belnet, storageServer)
          }
          // swarm_tick communication error
          if (str.match(/Failed to contact local Beldexd/)) {
            var ts = Date.now()
            lastBeldexdContactFailures.push(ts)
            if (lastBeldexdContactFailures.length > 5) {
              lastBeldexdContactFailures.splice(-5)
            }
            if (!shuttingDown) {
              console.log('STORAGE: can not contact blockchain, failure count', lastBeldexdContactFailures.length, 'first', parseInt((ts - lastBeldexdContactFailures[0]) / 1000) + 's ago')
            }
            // if the oldest one is not more than 180s ago
            // it's not every 36s
            // a user provided a ss where there was 300s between the 1st and the 2nd
            // 0,334,374.469.730,784
            // where it should have been restarted, so 5 in 15 mins will be our new tune
            // was 11 * 36
            if (lastBeldexdContactFailures.length == 5 && ts - lastBeldexdContactFailures[0] < 900 * 1000) {
              // now it's a race, between us detect beldexd shutting down
              // and us trying to restart it...
              // mainly will help deadlocks
              if (!exitRequested) {
                console.log('we should restart beldexd');
                requestBlockchainRestart(config);
              }
            }
            if (storageLogging) console.log(`STORAGE: blockchain tick contact failure`)
            storageServer.blockchainFailures.last_blockchain_tick = Date.now()
            //communicate this out
            lib.savePids(config, args, beldex_daemon, belnet, storageServer)
          }
          if (storageLogging && outputError) console.log(`STORAGE: ${logLinesStr}`)
        }
      }
      //if (storageLogging) console.log(`STORAGE: ${logLinesStr}`)
    })
    .on('error', (err) => {
      console.error(`Storage Server stdout error: ${err.toString('utf8').trim()}`)
    })

  storageServer.stderr
    .on('data', (err) => {
      if (storageLogging) console.log(`Storage Server error: ${err.toString('utf8').trim()}`)
    })
    .on('error', (err) => {
      console.error(`Storage Server stderr error: ${err.toString('utf8').trim()}`)
    })

  function watchdogCheck() {
    // console.log('STORAGE: checking for deadlock')
    lib.runStorageRPCTest(belnet, config, function(data) {
      if (data === undefined) {
        console.log('STORAGE: RPC server not responding, restarting storage server')
        shutdown_storage()
      }
    })
  }

  function startupComplete() {
    console.log('STORAGE: Turning off storage server start up watcher, starting watchdog')
    collectData = false
    stdout = ''
    stderr = ''
    clearInterval(memoryWatcher)
    memoryWatcher = null
    watchdog = setInterval(watchdogCheck, 10 * 60 * 1000)
  }

  // don't hold up the exit too much
  let watchdog = null
  let memoryWatcher = setInterval(function() {
    lib.runStorageRPCTest(belnet, config, function(data) {
      if (data !== undefined) {
        startupComplete()
      }
    })
  }, 10 * 1000)

  storageServer.on('error', (err) => {
    console.error('STORAGEP_ERR:', JSON.stringify(err))
  })

  storageServer.on('close', (code, signal) => {
    if (memoryWatcher !== null) clearInterval(memoryWatcher)
    if (watchdog !== null) clearInterval(watchdog)
    console.log(`StorageServer process exited with code ${code}/${signal} after`, (Date.now() - storageServer.startTime)+'ms')
    storageServer.killed = true
    if (code == 1) {
      // these seem to be empty
      console.log(stdout, 'stderr', stderr)
      // also now can be a storage server crash
      // we can use a port to check to make sure...
      console.log('')
      console.warn('StorageServer bind port could be in use, please check to make sure.', config.storage.binary_path, 'is not already running on port', config.storage.port)
      // we could want to issue one kill just to make sure
      // however since we don't know the pid, we won't know if it's ours
      // or meant be running by another copy of the launcher
      // at least any launcher copies will be restarted
      //
      // we could exit, or prevent a restart
      storageServer = null // it's already dead
      // we can no longer shutdown here, if storage server crashes, we do need to restart it...
      //return shutdown_everything()
    }
    // code null means clean shutdown
    if (!shuttingDown) {
      // wait 30s
      setTimeout(function() {
        console.log('beldex_daemon is still running, restarting storageServer.')
        launcherStorageServer(config, args)
      }, 30 * 1000)
    }
  })

  /*
  function flushOutput() {
    if (!storageServer || storageServer.killed) {
      console.log('storageServer flushOutput lost handle, stopping flushing')
      return
    }
    storageServer.stdin.write("\n")
    // schedule next flush
    storageServer.outputFlushTimer = setTimeout(flushOutput, 1000)
  }
  console.log('starting log flusher for storageServer')
  storageServer.outputFlushTimer = setTimeout(flushOutput, 1000)
  */

  if (cb) cb(true)
}

let waitForBeldexKeyTimer = null
// as of 6.x storage and network not get their key via rpc call
function waitForBeldexKey(config, timeout, start, cb) {
  if (start === undefined) start = Date.now()
  if (config.storage.beldexd_key === undefined) {
    if (config.storage.enabled) {
      console.error('Storage beldexd_key is not configured')
      process.exit(1)
    }
    cb(true)
    return
  }
  console.log('DAEMON: Checking on', config.storage.beldexd_key)
  if (!fs.existsSync(config.storage.beldexd_key)) {
    if (timeout && (Date.now - start > timeout)) {
      cb(false)
      return
    }
    waitForBeldexKeyTimer = setTimeout(function() {
      waitForBeldexKey(config, timeout, start, cb)
    }, 1000)
    return
  }
  waitForBeldexKeyTimer = null
  cb(true)
}

// FIXME: make sure blockchain.rpc port is bound before starting...
let rpcUpTimer = null
function startStorageServer(config, args, cb) {
  //console.log('trying to get IP information about belnet')
  // does this belong here?
  if (config.storage.enabled) {
    if (config.storage.data_dir !== undefined) {
      if (!fs.existsSync(config.storage.data_dir)) {
        belnet.mkDirByPathSync(config.storage.data_dir)
      }
    }
  }

  function checkRpcUp(cb) {
    if (shuttingDown) {
      //if (cb) cb()
      console.log('STORAGE: Not going to start storageServer, shutting down.')
      return
    }
    // runStorageRPCTest(belnet, config, function(data) {
    //   if (data !== undefined) {
    //     return cb()
    //   }
    //})
    belnet.portIsFree(config.blockchain.rpc_ip, config.blockchain.rpc_port, function(portFree) {
      if (!portFree) {
        cb()
        return
      }
      rpcUpTimer = setTimeout(function() {
        checkRpcUp(cb)
      }, 5 * 1000)
    })
  }

  checkRpcUp(function() {
    config.storage.ip = '0.0.0.0';
    if (config.network.enabled) {
      lib.savePids(config, args, beldex_daemon, belnet, storageServer)
      launcherStorageServer(config, args, cb)
      /*
      belnet.getBelNetIP(function (ip) {
        // belnet has started, save config and various process pid
        lib.savePids(config, args, beldex_daemon, belnet, storageServer)
        if (ip) {
          console.log('DAEMON: Starting storageServer on', ip)
          config.storage.ip = ip
          launcherStorageServer(config, args, cb)
        } else {
          console.error('DAEMON: Sorry cant detect our belnet IP:', ip)
          if (cb) cb(false)
          //shutdown_everything()
        }
      })
      */
    } else if (config.storage.enabled) {
      /*
      belnet.getNetworkIP(function(err, localIP) {
        console.log('DAEMON: Starting storageServer on', localIP)
        // we can only ever bind to the local IP
        config.storage.ip = localIP
        launcherStorageServer(config, args, cb)
      })
      */
      launcherStorageServer(config, args, cb)
    } else {
      console.log('StorageServer is not enabled.')
    }
  })
}

function startBelnet(config, args, cb) {
  // we no longer need to wait for BeldexKey before starting network/storage
  // waitForBeldexKey(config, timeout, start, cb)
  if (configUtil.isBlockchainBinary3X(config) || configUtil.isBlockchainBinary4Xor5X(config)) {
    // 3.x-5.x, we need the key
    if (config.storage.beldexd_key === undefined) {
      if (config.storage.enabled) {
        console.error('Storage server enabled but no key location given.')
        process.exit(1)
      }
      if (config.network.enabled) {
        belnet.startServiceNode(config, function () {
          startStorageServer(config, args, cb)
        })
      } else {
        //console.log('no storage key configured')
        if (cb) cb(true)
      }
      return
    }
    console.log('DAEMON: Waiting for beldex key at', config.storage.beldexd_key)
    waitForBeldexKey(config, 30 * 1000, undefined, function(haveKey) {
      if (!haveKey) {
        console.error('DAEMON: Timeout waiting for beldex key.')
        // FIXME: what do?
        return
      }
      console.log('DAEMON: Got Beldex key!')
      if (config.network.enabled) {
        belnet.startServiceNode(config, function () {
          startStorageServer(config, args, cb)
        })
      } else {
        if (config.storage.enabled) {
          startStorageServer(config, args, cb)
        } else {
          if (cb) cb(true)
        }
      }
    })
  } else {
    // 6.x+, not key needed
    if (config.network.enabled) {
      config.network.onStart = function(config, instance, belnetProc) {
        lib.savePids(config, args, beldex_daemon, belnet, storageServer)
      }
      config.network.onStop = function(config, instance, belnetProc) {
        lib.savePids(config, args, beldex_daemon, belnet, storageServer)
      }
      belnet.startServiceNode(config, function () {
        belnetPidwatcher = setInterval(function() {
          // read pids.json
          var pids = lib.getPids(config)
          var belnetProc = belnet.isRunning()
          if (belnetProc) {
            // console.log('belnet pid is', belnetProc.pid, 'json is', pids.belnet)
            if (belnetProc.pid != pids.belnet) {
              console.warn('Updating belnet PID')
              lib.savePids(config, args, beldex_daemon, belnet, storageServer)
            }
          } else {
            console.log('no belnet pid', belnet)
          }
        }, 30 * 1000)
        startStorageServer(config, args, cb)
      })
    } else {
      if (config.storage.enabled) {
        startStorageServer(config, args, cb)
      } else {
        if (cb) cb(true)
      }
    }
  }
}

function startLauncherDaemon(config, interactive, entryPoint, args, debug, cb) {
  /*
  try {
    process.seteuid('rtharp')
    console.log(`New uid: ${process.geteuid()}`)
  } catch(err) {
    console.log(`Failed to set uid: ${err}`)
  }
  */
  function doStart() {
    function startBackgroundCode() {
      // backgrounded or launched in interactive mode
      // strip any launcher-specific params we shouldn't need any more
      for(var i in args) {
        var arg = args[i]
        if (arg == '--skip-storage-server-port-check') {
          args.splice(i, 1) // remove this option
        } else
        if (arg == '--ignore-storage-server-port-check') {
          args.splice(i, 1) // remove this option
        }
      }
      //console.log('backgrounded or launched in interactive mode')
      g_config = config
      lib.setStartupLock(config)
      cb()
    }

    // see if we need to detach
    //console.log('interactive', interactive)
    if (!interactive) {
      //console.log('fork check', process.env.__daemon)
      if (!process.env.__daemon || config.launcher.cimode) {
        //console.log('cimode', config.launcher.cimode)
        let child
        if (!config.launcher.cimode) {
          // first run
          process.env.__daemon = true
          // spawn as child
          const cp_opt = {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
            cwd: process.cwd(),
            detached: true
          }
          // this doesn't work like this...
          //args.push('1>', 'log.out', '2>', 'err.out')
          console.log('Launching', process.execPath, entryPoint, 'daemon-start', args)
          child = spawn(process.execPath, [entryPoint, 'daemon-start', '--skip-storage-server-port-check'].concat(args), cp_opt)
          //console.log('child', child)
          if (!child) {
            console.error('Could not spawn detached process')
            process.exit(1)
          }
          // won't accumulate cause we're quitting...
          var stdout = '', stderr = ''
          child.stdout.on('data', (data) => {
            //if (debug) console.log(data.toString())
            stdout += data.toString()
          })
          child.stderr.on('data', (data) => {
            //if (debug) console.error(data.toString())
            stderr += data.toString()
          })
          //var launcherHasExited = false
          function crashHandler(code, signal) {
            console.log('Background launcher died with', code, signal, stdout, stderr)
            //launcherHasExited = true
            process.exit(1)
          }
          child.on('close', crashHandler)
        }
        // required so we can exit
        var startTime = Date.now()
        console.log('Waiting on start up confirmation...')
        function areWeRunningYet() {
          var diff = Date.now() - startTime
          // , process.pid
          console.log('Checking start up progress...')
          lib.getLauncherStatus(config, belnet, 'waiting...', function(running, checklist) {
            var nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
            if (nodeVer >= 10) {
              console.table(checklist)
            } else {
              console.log(checklist)
            }
            var pids = lib.getPids(config) // need to get the config
            // blockchain rpc is now required for SN

            var blockchainIsFine = pids.runningConfig && pids.runningConfig.blockchain && checklist.blockchain_rpc !== 'waiting...'
            var networkIsFine = (!pids.runningConfig) || (!pids.runningConfig.network) || (!pids.runningConfig.network.enabled) || (checklist.network !== 'waiting...')
            if (running.launcher && running.beldexd && checklist.socketWorks !== 'waiting...' &&
                  pids.runningConfig && blockchainIsFine && networkIsFine &&
                  checklist.storageServer !== 'waiting...' && checklist.storage_rpc !== 'waiting...'
                ) {
              console.log('Start up successful!')
              if (child) child.removeListener('close', crashHandler)
              process.exit()
            }
            // if storage is enabled but not running, wait for it
            if (pids.runningConfig && pids.runningConfig.storage.enabled && checklist.storageServer === 'waiting...' && blockchainIsFine && networkIsFine) {
              // give it 30s more if everything else is fine... for what?
              if (diff > 1.5  * 60 * 1000) {
                console.log('Storage server start up timeout, likely failed.')
                process.exit(1)
              }
              setTimeout(areWeRunningYet, 5000)
              return
            }
            if (pids.runningConfig && pids.runningConfig.storage.enabled && checklist.storage_rpc === 'waiting...' && blockchainIsFine && networkIsFine) {
              // give it 15s more if everything else is fine... for it's DH generation
              if (diff > 1.75 * 60 * 1000) {
                console.log('Storage server rpc timeout, likely DH generation is taking long...')
                process.exit(0)
              }
              setTimeout(areWeRunningYet, 5000)
              return
            }
            if (diff > 1   * 60 * 1000) {
              console.log('Start up timeout, likely failed.')
              process.exit(1)
            }
            //if (!launcherHasExited) {
            setTimeout(areWeRunningYet, 5000)
            //}
          })
        }
        setTimeout(areWeRunningYet, 5000)
        if (child) child.unref()
        if (config.launcher.cimode) {
          console.log('continuing foreground startup')
          startBackgroundCode()
        }
        return
      }
      // no one sees these
      //console.log('backgrounded')
    } else {
      // interactive is mainly for beldexd
      if (!debug) {
        belnet.disableLogging(true)
        storageLogging = false
      }
    }

    startBackgroundCode()
  }
  function testOpenPorts() {
    // move deterministic behavior than letting the OS decide
    console.log('Starting verification phase')
    console.log('Downloading test servers from testing.belnet.org')
    dns.resolve4('testing.belnet.org', function(err, addresses) {
      if (err) console.error('dnsLookup err', err)
      //console.log('addresses', addresses)
      function tryAndConnect() {
        var idx = parseInt(Math.random() * addresses.length)
        var server = addresses[idx]
        /*
        dns.resolvePtr(server, function(err, names) {
          if (err) console.error('dnsPtrLookup err', err)
          if (names.length) console.log('trying to connect to', names[0])
        })
        */
        console.log('Trying to connect to', server)
        addresses.splice(idx, 1) // remove it
        networkTest.createClient(server, 3000, async function(client) {
          //console.log('client', client)
          if (debug) console.debug('got createClient cb')
          if (client === false) {
            if (!addresses.length) {
              console.warn('We could not connect to ANY testing server, you may want to check your internet connection and DNS settings')
              /*
              setTimeout(function() {
                testOpenPorts()
              }, 30 * 1000)
              */
              console.log('Verification phase complete')
              doStart()
            } else {
              // retry with a different server
              tryAndConnect()
            }
            return
          }

          // select your tests
          const ourTests = []
          if (!configUtil.isBlockchainBinary3X(config) && !configUtil.isBlockchainBinary4Xor5X(config)) {
            ourTests.push({
              name: 'blockchain quorumnet',
              shortName: 'OpenQuorumNetPort',
              type: 'tcp',
              outgoing: false,
              recommended: false,
              port: config.blockchain.qun_port
            },
            {
              name: 'storage server',
              shortName: 'OpenStoragePort',
              type: 'tcp',
              outgoing: false,
              recommended: false,
              port: config.storage.port
            })
            if (configUtil.isBlockchainBinary7X(config)) {
              ourTests.push({
                name: 'storage server LMQ',
                shortName: 'OpenStorageLMQPort',
                type: 'tcp',
                outgoing: false,
                recommended: false,
                port: config.storage.lmq_port
              })
            }
            if (config.network.enabled) {
              ourTests.push({
                name: 'network incoming',
                shortName: 'OpenNetworkRecvPort',
                type: 'udp',
                outgoing: false,
                recommended: false,
                port: config.network.public_port
              },
              {
                name: 'network outgoing',
                shortName: 'OpenNetworkSendPort',
                type: 'udp',
                outgoing: true,
                recommended: false,
                port: config.network.public_port
              })
            }
          } else {
            if (config.storage.enabled) {
              ourTests.push({
                name: 'storage server',
                shortName: 'OpenStoragePort',
                type: 'tcp',
                outgoing: false,
                recommended: false,
                port: config.storage.port
              })
            }
          }

          function runTest(test) {
            return new Promise((resolve, rej) => {
              console.log('Starting open port check on configured', test.name, (test.type === 'tcp' ? 'TCP':'UDP'), 'port:', test.port)
              p2 = debug
              testName = 'startTestingServer'
              if (test.type === 'udp') {
                if (test.outgoing) {
                  testName = 'testUDPSendPort'
                  p2 = 1090
                } else {
                  testName = 'startUDPRecvTestingServer'
                }
              }
              client[testName](test.port, p2, function(results, port) {
                if (results != 'good') {
                  if (results === 'inuse') {
                    console.error((test.type === 'udp' ? 'UDP' : 'TCP') + ' PORT ' + port +
                      ' ' + (test.outgoing?'OUTGOING':'INCOMING') +
                      ' is already in use, please make sure nothing is using the port before trying again')
                  } else {
                    let wasTimeout = false
                    if (port === 'ETIMEDOUT') {
                      port = test.port
                      wasTimeout = true
                    }
                    console.error('WE COULD NOT VERIFY THAT YOU HAVE ' +
                      (test.type === 'udp' ? 'UDP' : 'TCP') + ' PORT ' + port +
                      ' ' + (test.outgoing?'OUTGOING':'INCOMING') +
                      ', OPEN ON YOUR FIREWALL/ROUTER, this is ' + (test.recommended?'recommended':'required') + ' to run a master node')
                    if (wasTimeout) {
                      console.warn('There was a timeout, please retry')
                    }
                  }

                  for(var i in args) {
                    var arg = args[i]
                    if (arg == '--ignore-storage-server-port-check') {
                      client.disconnect()
                      console.log('verification phase complete (ignoring checks)')
                      args.splice(i, 1) // remove this option
                      doStart()
                      return
                    }
                  }
                  process.exit(1)
                }
                resolve()
              })
            })
          }

          for(test of ourTests) {
            await runTest(test)
          }
          console.log('verification phase complete.')
          client.disconnect()
          doStart()

        }) // end createClient
      } // end func tryAndConnect
      tryAndConnect()
    }) // end resolve
  }
  if (config.storage.enabled || config.network.enabled) {
    for(var i in args) {
      var arg = args[i]
      if (arg == '--skip-storage-server-port-check') {
        args.splice(i, 1) // remove this option
        doStart()
        return
      }
    }
    testOpenPorts()
  } else {
    doStart()
  }
}

// compile config into CLI arguments
// only needs to be ran when config changes
function configureBeldexd(config, args) {
  var beldexd_options = ['--master-node']

  // if ip is not localhost, pass it to beldexd
  if (config.blockchain.rpc_ip && config.blockchain.rpc_ip != '127.0.0.1') {
    beldexd_options.push('--rpc-bind-ip='+config.blockchain.rpc_ip, '--confirm-external-bind')
  }

  if (config.blockchain.rpc_pass) {
    beldexd_options.push('--rpc-login='+config.blockchain.rpc_user+':'+config.blockchain.rpc_pass)
  }
  if (!config.launcher.interactive) {
    // we handle the detach, we don't need to detach beldexd from us
    // we need this now to keep a console open
    //beldexd_options.push('--non-interactive')
    // if we leave this disabled, we won't be able to see startup errors
    // only really good for debugging beldexd stuffs
    //belnet.disableLogging()
  }
  if (config.blockchain.zmq_port) {
    beldexd_options.push('--zmq-rpc-bind-port=' + config.blockchain.zmq_port)
  }
  // FIXME: be nice to skip if it was the default...
  // can we turn it off?
  if (config.blockchain.rpc_port) {
    beldexd_options.push('--rpc-bind-port=' + config.blockchain.rpc_port)
  }
  if (config.blockchain.p2p_port) {
    beldexd_options.push('--p2p-bind-port=' + config.blockchain.p2p_port)
  }
  if (config.blockchain.data_dir) {
    beldexd_options.push('--data-dir=' + config.blockchain.data_dir)
  }

  // net selection at the very end because we may need to override a lot of things
  // but not before the dedupe
  if (config.blockchain.network == "test") {
    beldexd_options.push('--testnet')
  } else
  if (config.blockchain.network == "demo") {
    beldexd_options.push('--testnet')
    beldexd_options.push('--add-priority-node=116.203.126.14')
  } else
  if (config.blockchain.network == "staging") {
    beldexd_options.push('--stagenet')
  }

  // logical core count
  let cpuCount = os.cpus().length
  if (fs.existsSync('/sys/devices/system/cpu/online')) {
    // 0-63
    const cpuData = fs.readFileSync('/sys/devices/system/cpu/online')
    cpuCount = parseInt(cpuData.toString().replace(/^0-/, '')) + 1
  }
  console.log('CPU Count', cpuCount)
  // getconf _NPROCESSORS_ONLN
  // /sys/devices/system/cpu/online
  if (cpuCount > 16) {
    beldexd_options.push('--max-concurrency=16')
  }

  // not 3.x
  if (!configUtil.isBlockchainBinary3X(config)) {
    // 4.x+
    beldexd_options.push('--storage-server-port', config.storage.port)
    beldexd_options.push('--master-node-public-ip', config.launcher.publicIPv4)
  } else {
    console.log('3.x blockchain block binary detected')
  }
  // 6.x+
  if (!configUtil.isBlockchainBinary3X(config) && !configUtil.isBlockchainBinary4Xor5X(config) && config.blockchain.qun_port) {
    beldexd_options.push('--quorumnet-port=' + config.blockchain.qun_port)
  }

  // copy CLI options to beldexd
  for (var i in args) {
    // should we prevent --non-interactive?
    // probably not, if they want to run it that way, why not support it?
    // FIXME: we just need to adjust internal config
    var arg = args[i]
    if (arg.match(/=/)) {
      // assignment
      var parts = arg.split(/=/)
      var key = parts.shift()
      for(var j in beldexd_options) {
        var option = beldexd_options[j] + '' // have to convert to string because number become numbers
        if (option.match && option.match(/=/)) {
          var parts2 = option.split(/=/)
          var option_key = parts2.shift()
          if (option_key == key) {
            console.log('BLOCKCHAIN: Removing previous established option', option)
            beldexd_options.splice(j, 1)
          }
        }
      }
    } else {
      for(var j in beldexd_options) {
        var option = beldexd_options[j]
        if (arg == option) {
          console.log('BLOCKCHAIN: Removing previous established option', option)
          beldexd_options.splice(j, 1)
        }
      }
    }
    beldexd_options.push(args[i])
  }

  return {
    beldexd_options: beldexd_options,
  }
}

var beldex_daemon
var savePidConfig = {}
function launchBeldexd(binary_path, beldexd_options, interactive, config, args, cb) {
  if (shuttingDown) {
    //if (cb) cb()
    console.log('BLOCKCHAIN: Not going to start beldexd, shutting down.')
    return
  }
  // hijack STDIN but not OUT/ERR
  //console.log('launchBeldexd - interactive?', interactive)
  if (interactive) {
    // don't hijack stdout, so prepare_registration works
    console.log('BLOCKCHAIN: (interactive mode) Launching', binary_path, beldexd_options.join(' '))
    beldex_daemon = spawn(binary_path, beldexd_options, {
      stdio: ['pipe', 'inherit', 'inherit'],
      //shell: true
    })
  } else {
    // allow us to hijack stdout
    console.log('BLOCKCHAIN: Launching', binary_path, beldexd_options.join(' '))
    beldex_daemon = spawn(binary_path, beldexd_options)
  }
  if (!beldex_daemon) {
    console.error('BLOCKCHAIN: Failed to start beldexd, exiting...')
    shutdown_everything()
    return
  }

  beldex_daemon.on('error', (err) => {
    console.error('BLOCKCHAINP_ERR:', JSON.stringify(err))
  })

  beldex_daemon.startTime = Date.now()
  beldex_daemon.startedOptions = beldexd_options
  savePidConfig = {
    config: config,
    args: args,
  }
  lib.savePids(config, args, beldex_daemon, belnet, storageServer)

  if (!interactive && !config.blockchain.quiet) {
    // why is the banner held back until we connect!?
    beldex_daemon.stdout.on('data', (data) => {
      console.log(`blockchainRAW: ${data}`)
      //var parts = data.toString().split(/\n/)
      //parts.pop()
      //stripped = parts.join('\n')
      //console.log(`blockchain: ${stripped}`)
      // seems to be working...
      if (server) {
        // broadcast
        for (var i in connections) {
          var conn = connections[i]
          conn.write(data + "\n")
        }
      }
      // FIXME: if we don't get `Received uptime-proof confirmation back from network for Master Node (yours): <24030a316d4b8379a4a7be640ee716632d40f76f2784074bcbffc4b0c617d6b7>`
      // at least once every 2 hours, restart beldexd
    })
    beldex_daemon.stdout.on('error', (err) => {
      console.error('BLOCKCHAIN1_ERR:', JSON.stringify(err))
    })
    beldex_daemon.stderr.on('data', (data) => {
      console.log(`blockchainErrRAW: ${data}`)
      //var parts = data.toString().split(/\n/)
      //parts.pop()
      //stripped = parts.join('\n')
      //console.log(`blockchain: ${stripped}`)
      // seems to be working...
      if (server) {
        // broadcast
        for (var i in connections) {
          var conn = connections[i]
          conn.write("ERR" + data + "\n")
        }
      }
    })
    beldex_daemon.stderr.on('error', (err) => {
      console.error('BLOCKCHAIN1_ERR:', JSON.stringify(err))
    })
  }

  beldex_daemon.on('close', (code, signal) => {
    if (beldex_daemon === null) {
      // was shutting down when it was restarted...
      beldex_daemon = {
        shuttingDownRestart: true // set something we can modify behavior on
      }
    }
    console.warn(`BLOCKCHAIN: beldex_daemon process exited with code ${code}/${signal} after`, (Date.now() - beldex_daemon.startTime)+'ms')
    // invalid param gives a code 1
    // code 0 means clean shutdown
    if (code === 0) {
      // likely to mean it was requested
      if (config.blockchain.restart) {
        // we're just going to restart
        if (server) {
          // broadcast
          for (var i in connections) {
            var conn = connections[i]
            conn.write("Beldexd has been exited but configured to restart. Disconnecting client and we'll be back shortly\n")
          }
        }
        // but lets disconnect any clients
        disconnectAllClients()
      }
    }

    // if we have a handle on who we were...
    if (beldex_daemon) {
      beldex_daemon.killed = true
      // clean up temporaries
      //killOutputFlushTimer()
      if (beldex_daemon.outputFlushTimer) {
        clearTimeout(beldex_daemon.outputFlushTimer)
        beldex_daemon.outputFlushTimer = undefined
      }
    }
    if (!shuttingDown) {
      // if we need to restart
      if (config.blockchain.restart) {
        console.log('BLOCKCHAIN: beldexd is configured to be restarted. Will do so in 30s.')
        // restart it in 30 seconds to avoid pegging the cpu
        setTimeout(function () {
          console.log('BLOCKCHAIN: Restarting beldexd.')
          launchBeldexd(config.blockchain.binary_path, beldexd_options, config.launcher.interactive, config, args)
        }, 30 * 1000)
      } else {
        if (waitForBeldexKeyTimer !== null) clearTimeout(waitForBeldexKeyTimer)
        shutdown_everything()
      }
    }
  })


  function flushOutput() {
    if (!beldex_daemon) {
      console.log('BLOCKCHAIN: flushOutput lost handle, stopping flushing.')
      return
    }
    // FIXME turn off when in prepare status...
    beldex_daemon.stdin.write("\n")
    // schedule next flush
    beldex_daemon.outputFlushTimer = setTimeout(flushOutput, 1000)
  }
  // disable until we can detect prepare_reg
  // don't want to accidentally launch with prepare_reg broken
  //beldex_daemon.outputFlushTimer = setTimeout(flushOutput, 1000)

  if (cb) cb()
}

var requestBlockchainRestartLock = false
function requestBlockchainRestart(config, cb) {
  if (shuttingDown) {
    console.log('LAUNCHER: not going to restart beldexd, we are shutting down')
    return
  }
  if (requestBlockchainRestartLock) {
    console.log('LAUNCHER: already restarting blockchain')
    return
  }
  requestBlockchainRestartLock = true
  var oldVal = config.blockchain.restart
  var obj = lib.getPids(config)
  config.blockchain.restart = 1
  console.log('LAUNCHER: requesting blockchain restart')
  shutdown_blockchain()
  waitfor_blockchain_shutdown(function() {
    if (shuttingDown) {
      console.log('LAUNCHER: not going to restart beldexd, we are shutting down')
      return
    }
    console.log('BLOCKCHAIN: Restarting beldexd.')
    launchBeldexd(config.blockchain.binary_path, obj.blockchain_startedOptions, config.launcher.interactive, config, obj.arg)
    requestBlockchainRestartLock = false
    config.blockchain.restart = oldVal
    if (cb) cb()
  })
}

function sendToClients(data) {
  if (server) {
    // broadcast
    for(var i in connections) {
      var conn = connections[i]
      conn.write(data + "\n")
    }
  }
}

function belnet_onMessageSockerHandler(data) {
  if (belnet.belnetLogging) {
    console.log(`belnet: ${data}`)
    sendToClients('NETWORK: ' + data + '\n')
  }
  const tline = data
  const belnetProc = belnet.isRunning()
  // blockchain ping
  if (tline.match(/invalid result from beldexd ping, not an object/) || tline.match(/invalid result from beldexd ping, no result/) ||
      tline.match(/invalid result from beldexd ping, status not an string/) || tline.match(/beldexd ping failed:/) ||
      tline.match(/Failed to ping beldexd/)) {
    belnetProc.blockchainFailures.last_blockchain_ping = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, beldex_daemon, belnet, storageServer)
  }
  // blockchain identity
  if (tline.match(/beldexd gave no identity key/) || tline.match(/beldexd gave invalid identity key/) ||
      tline.match(/beldexd gave bogus identity key/) || tline.match(/Bad response from beldexd:/) ||
      tline.match(/failed to get identity keys/) || tline.match(/failed to init curl/)) {
    belnetProc.blockchainFailures.last_blockchain_identity = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, beldex_daemon, belnet, storageServer)
  }
  // blockchain get servide node
  if (tline.match(/Invalid result: not an object/) || tline.match(/Invalid result: no master_node_states member/) ||
      tline.match(/Invalid result: master_node_states is not an array/)) {
    belnetProc.blockchainFailures.last_blockchain_mnode = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, beldex_daemon, belnet, storageServer)
  }
}
function belnet_onErrorSockerHandler(data) {
  console.log(`belneterr: ${data}`)
  sendToClients('NETWORK ERR: ' + data + '\n')
}

function setUpBelnetHandlers() {
  belnet.onMessage = belnet_onMessageSockerHandler
  belnet.onError   = belnet_onErrorSockerHandler
}

function handleInput(line) {
  if (line.match(/^network/i)) {
    var remaining = line.replace(/^network\s*/i, '')
    if (remaining.match(/^log/i)) {
      var param = remaining.replace(/^log\s*/i, '')
      //console.log('belnet log', param)
      if (param.match(/^off/i)) {
        belnet.disableLogging()
      }
      if (param.match(/^on/i)) {
        belnet.enableLogging()
      }
    }
    return true
  }
  if (line.match(/^storage/i)) {
    var remaining = line.replace(/^storage\s*/i, '')
    if (remaining.match(/^log/i)) {
      var param = remaining.replace(/^log\s*/i, '')
      //console.log('belnet log', param)
      if (param.match(/^off/i)) {
        storageLogging = false
      }
      if (param.match(/^on/i)) {
        storageLogging = true
      }
    }
    return true
  }
  // FIXME: it'd be nice to disable the periodic status report msgs in interactive too
  return false
}

// startBeldexd should generate a current config for launcherBeldexd
// but the launcherBeldexd config should be locked in and not changeable
// so startBeldexd is the last opportunity to update it
// and we'll recall this function if we need to update the config too...
// also implies we'd need a reload other than HUP, USR1?
function startBeldexd(config, args) {
  var parameters = configureBeldexd(config, args)
  var beldexd_options = parameters.beldexd_options
  //console.log('configured ', config.blockchain.binary_path, beldexd_options.join(' '))

  launchBeldexd(config.blockchain.binary_path, beldexd_options, config.launcher.interactive, config, args)

  // if we're interactive (and no docker grab) the console
  if (config.launcher.interactive && lib.falsish(config.launcher.docker)) {
    // resume stdin in the parent process (node app won't quit all by itself
    // unless an error or process.exit() happens)
    stdin.resume()

    // i don't want binary, do you?
    stdin.setEncoding('utf8')

    // on any data into stdin
    stdin.on('data', function (key) {
      // ctrl-c ( end of text )
      if (key === '\u0003') {
        shutdown_everything()
        return
      }
      if (handleInput(key)) return
      if (!shuttingDown) {
        // local echo, write the key to stdout all normal like
        // on ssh we don't need this
        //process.stdout.write(key)

        // only if beldexd is running, send input
        if (beldex_daemon) {
          beldex_daemon.stdin.write(key)
        }
      }
      if (key === 'exit\n') {
        console.log('detected exit')
        // can't do this, this will prevent beldex_daemon exit
        // from shuttingdown everything
        // shuttingDown = true
        exitRequested = true
      }
    })
    stdin.on('error', function(err) {
      console.error('STDIN ERR:', JSON.stringify(err))
    })
  } else {
    // we're non-interactive, set up socket server
    console.log('SOCKET: Starting')
    server = net.createServer((c) => {
      console.log('SOCKET: Client connected.')
      connections.push(c)
      c.setEncoding('utf8')
      c.on('end', () => {
        console.log('SOCKET: Client disconnected.')
        var idx = connections.indexOf(c)
        if (idx != -1) {
          connections.splice(idx, 1)
        }
      })
      c.on('error', (err) => {
        if (c.connected) {
          c.write('SOCKETERR: ' + JSON.stringify(err))
        } else {
          if (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') {
            // make sure we remove ourself from broadcasts (beldexd stdout writes)...
            var idx = connections.indexOf(c)
            if (idx != -1) {
              connections.splice(idx, 1)
            }
            // leave it to the client to reconnect
            // I don't think we need to log this
            // FIXME: don't CONNRESET when ctrl-c disconnecting the client...
          } else {
            console.log('Not connected, SOCKETERR:', JSON.stringify(err))
          }
        }
      })
      c.on('data', (data) => {
        var parts = data.toString().split(/\n/)
        parts.pop()
        stripped = parts.join('\n')
        console.log('SOCKET: got', stripped)
        if (handleInput(stripped)) return
        if (beldex_daemon && !beldex_daemon.killed) {
          console.log('SOCKET: Sending to beldexd.')
          beldex_daemon.stdin.write(data + "\n")
        }
      })
      c.write('Connection successful\n')
      // confirmed error is already catch above
      c.pipe(c)/* .on('error', function(err) {
        console.error('SOCKETSRV_ERR:', JSON.stringify(err))
      }) */
    })
    setUpBelnetHandlers()

    server.on('error', (err) => {
      if (err.code == 'EADDRINUSE') {
        // either already running or we were killed
        // try to connect to it
        net.connect({ path: config.launcher.var_path + '/launcher.socket' }, function () {
          // successfully connected, then it's in use...
          throw e;
        }).on('error', function (e) {
          if (e.code !== 'ECONNREFUSED') throw e
          console.log('SOCKET: socket is stale, nuking')
          fs.unlinkSync(config.launcher.var_path + '/launcher.socket')
          server.listen(config.launcher.var_path + '/launcher.socket')
        })
        return
      }
      console.error('SOCKET ERROR:', err)
      // some errors we need to shutdown
      //shutdown_everything()
    })

    server.listen(config.launcher.var_path + '/launcher.socket', () => {
      console.log('SOCKET: bound')
    })
  }

  if (config.web_api.enabled) {
    webApiServer = require(__dirname + '/web_api').start(config)
  }

  // only set up these handlers if we need to
  setupHandlers()
}

function getInterestingDaemonData() {
  var ts = Date.now()
  var belnet_daemon = belnet.getBelnetDaemonObj();
  var procInfo = {
    blockchain: {
      pid: beldex_daemon?beldex_daemon.pid:0,
      killed: beldex_daemon?beldex_daemon.killed:false,
      uptime: beldex_daemon?(ts - beldex_daemon.startTime):0,
      startTime: beldex_daemon?beldex_daemon.startTime:0,
      spawnfile: beldex_daemon?beldex_daemon.spawnfile:'',
      spawnargs: beldex_daemon?beldex_daemon.spawnargs:'',
    },
    network: {
      pid: belnet?belnet.pid:belnet,
      killed: belnet?belnet.killed:false,
      uptime: belnet?(ts - belnet.startTime):0,
      startTime: belnet?belnet.startTime:0,
      spawnfile: belnet?belnet.spawnfile:'',
      spawnargs: belnet?belnet.spawnargs:'',
    },
    storage: {
      pid: storageServer?storageServer.pid:0,
      killed: storageServer?storageServer.killed:false,
      uptime: storageServer?(ts - storageServer.startTime):0,
      startTime: storageServer?storageServer.startTime:0,
      spawnfile: storageServer?storageServer.spawnfile:'',
      spawnargs: storageServer?storageServer.spawnargs:'',
    },
  }
  return procInfo;
}

var handlersSetup = false
function setupHandlers() {
  if (handlersSetup) return
  process.on('SIGHUP', () => {
    console.log('got SIGHUP!')
    if (savePidConfig.config) {
      console.log('updating pids file', savePidConfig.config.launcher.var_path + '/pids.json')
      lib.savePids(savePidConfig.config, savePidConfig.args, beldex_daemon, belnet, storageServer)
    }
    console.log('shuttingDown?', shuttingDown)
    const procInfo = getInterestingDaemonData()
    var nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
    if (nodeVer >= 10) {
      console.table(procInfo)
    } else {
      console.log(procInfo)
    }
    console.log('belnet status', belnet.isRunning())
  })
  // ctrl-c
  process.on('SIGINT', function () {
    console.log('LAUNCHER daemon got SIGINT (ctrl-c)')
    shutdown_everything()
  })
  // -15
  process.on('SIGTERM', function () {
    console.log('LAUNCHER daemon got SIGTERM (kill -15)')
    shutdown_everything()
  })
  handlersSetup = true
}

module.exports = {
  startLauncherDaemon: startLauncherDaemon,
  startBelnet: startBelnet,
  startStorageServer: startStorageServer,
  startBeldexd: startBeldexd,
  // for lib::runOfflineBlockchainRPC
  configureBeldexd: configureBeldexd,
  launchBeldexd: launchBeldexd,
  //
  waitForBeldexKey: waitForBeldexKey,
  setupHandlers: setupHandlers,
  shutdown_everything: shutdown_everything,
  config: {}
}
