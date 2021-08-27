// no npm!
const os = require('os')
const fs = require('fs')
const dns = require('dns')
const net = require('net')
const ini = require(__dirname + '/ini')
const path = require('path')
const http = require('http')
const https = require('https')
const urlparser = require('url')
const { spawn, exec, execSync } = require('child_process')

// FIXME: disable rpc if desired
const VERSION = 0.9
//console.log('belnet launcher version', VERSION, 'registered')

var belnet_version = 'notStartedYet'

function log() {
  var args = []
  for (var i in arguments) {
    var arg = arguments[i]
    //console.log('arg type', arg, 'is', typeof(arg))
    if (typeof (arg) == 'object') {
      arg = JSON.stringify(arg)
    }
    args.push(arg)
  }
  console.log('NETWORK:', args.join(' '))
}

function getBoundIPv4s() {
  var nics = os.networkInterfaces()
  var ipv4s = []
  for (var adapter in nics) {
    var ips = nics[adapter]
    for (var ipIdx in ips) {
      var ipMap = ips[ipIdx]
      if (ipMap.address.match(/\./)) {
        ipv4s.push(ipMap.address)
      }
    }
  }
  return ipv4s
}

var auto_config_test_port, auto_config_test_host, auto_config_test_ips
// this doesn't need to connect completely to get our ip
// it won't get our IP if DNS doesn't work
function getNetworkIP(callback) {
  // randomly select an ip
  //log('getNetworkIP', auto_config_test_ips)
  var ip = auto_config_test_ips[Math.floor(Math.random() * auto_config_test_ips.length)]
  //log('getNetworkIP from', ip, auto_config_test_port)
  var socket = net.createConnection(auto_config_test_port, ip)
  socket.setTimeout(5000)
  socket.on('connect', function () {
    callback(undefined, socket.address().address)
    socket.end()
  })
  var abort = false
  socket.on('timeout', function () {
    if (socket.address().address) {
      abort = true
      var resultIp = socket.address().address
      log('getNetworkIP timeout [', ip + ':' + auto_config_test_port, '] but still got outgoing IP:', resultIp)
      socket.destroy()
      callback(undefined, resultIp)
    } else {
      // don't have what we need, just wait it out, maybe we'll get lucky
      //log('getNetworkIP timeout')
      //callback('timeout', 'error')
    }
  })
  socket.on('error', function (e) {
    console.error('NETWORK: getNetworkIP error', e)
    // FIXME: maybe a retry here
    log('getNetworkIP failure test', socket.address().address)
    log('getNetworkIP failure, retry?')
    if (abort) {
      log('getNetworkIP already timed out')
      return
    }
    callback(e, 'error')
  })
}

function getIfNameFromIP(ip) {
  var nics = os.networkInterfaces()
  var ipv4s = []
  for (var adapter in nics) {
    var ips = nics[adapter]
    for (var ipIdx in ips) {
      var ipMap = ips[ipIdx]
      if (ipMap.address == ip) {
        return adapter
      }
    }
  }
  return ''
}

// how do we abort protoClient externally and have more than one inflight...
// we set a property in the promise object returned...
function httpGet(url, cb) {
  const urlDetails = urlparser.parse(url)
  //console.log('httpGet url', urlDetails)
  //console.log('httpGet', url)
  var protoClient = http
  if (urlDetails.protocol == 'https:') {
    protoClient = https
  }
  var ref
  var p = new Promise(function(resolve, reject) {
    // well somehow this can get hung on macos
    var abort = false
    var stopWatchdog = setInterval(function () {
      if (shuttingDown) {
        // [', url, ']
        log('hung httpGet but have shutdown request, calling back early and setting abort flag')
        clearInterval(stopWatchdog)
        // actually cancel the download
        if (ref && ref.abort) ref.abort()
        abort = true
        if (cb) cb()
          else reject()
        return
      }
    }, 5000)
    ref = protoClient.get({
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
      clearInterval(stopWatchdog)
      resp.setEncoding('binary')
      let data = ''
      // A chunk of data has been recieved.
      resp.on('data', (chunk) => {
        data += chunk
      })
      // The whole response has been received. Print out the result.
      resp.on('end', () => {
        // warn if not perfect
        if (resp.statusCode != 200) {
          log('httpGet result code', resp.statusCode)
        }
        if (abort) {
          // we already called back
          return
        }
        // hijack 300s
        if (resp.statusCode === 301 || resp.statusCode === 302) {
          if (resp.headers.location) {
            let loc = resp.headers.location
            if (!loc.match(/^http/)) {
              if (loc.match(/^\//)) {
                // absolute path
                loc = urlDetails.protocol + '//' + urlDetails.hostname + ':' + urlDetails.port + loc
              } else {
                // relative path
                loc = urlDetails.protocol + '//' + urlDetails.hostname + ':' + urlDetails.port + urlDetails.path + loc
              }
            }
            console.log('NETWORK: httpGet Redirecting to', loc)
            return httpGet(loc, cb)
          }
        }
        // fail on 400s
        if (resp.statusCode === 404 || resp.statusCode === 403) {
          if (resp.statusCode === 403) console.error('NETWORK:', url, 'is forbidden')
          if (resp.statusCode === 404) console.error('NETWORK:', url, 'is not found')
          if (cb) cb()
            else reject()
          return
        }
        if (cb) cb(data)
        resolve(data)
      })
    }).on("error", (err) => {
      console.error("NETWORK: httpGet Error: " + err.message, 'port', urlDetails.port)
      clearInterval(stopWatchdog)
      //console.log('err', err)
      if (cb) cb()
        else reject()
    })
  })
  p.ref = ref
  return p
}

function dynDNSHandler(data, cb) {

}

function getPublicIPv6(cb) {
  //v6.ident.me
}

var getPublicIPv4_retries = 0
async function getPublicIPv4(cb) {
  // trust more than one source
  // randomly find 2 matching sources

  // dns is faster than http
  // dig +short myip.opendns.com @resolver1.opendns.com
  // httpGet doesn't support https yet...
  var publicIpServices = [
    { url: 'https://api.ipify.org' },
    { url: 'https://ipinfo.io/ip' },
    { url: 'https://ipecho.net/plain' },
    //{ url: 'http://api.ipify.org' },
    //{ url: 'http://ipinfo.io/ip' },
    //{ url: 'http://ipecho.net/plain' },
    { url: 'http://ifconfig.me/ip' },
    { url: 'http://ipv4.icanhazip.com' },
    { url: 'http://v4.ident.me' },
    { url: 'http://checkip.amazonaws.com' },
    //{ url: 'https://checkip.dyndns.org', handler: dynDNSHandler },
  ]
  var service = []
  service[0] = Math.floor(Math.random() * publicIpServices.length)
  service[1] = service[0]
  while (service[1] == service[0]) {
    service[1] = Math.floor(Math.random() * publicIpServices.length)
  }
  var done = [false, false]

  let doneResolver
  const donePromise = new Promise(res => {
    doneResolver = res
  })

  function markDone(idx, value) {
    if (value === undefined) value = ''
    done[idx] = value.trim()
    let ready = true
    //log('done', done)
    for (var i in done) {
      if (done[i] === false) {
        ready = false
        // log('getPublicIPv4', i, 'is not ready')
        break
      }
    }
    if (!ready) return
    // log('getPublicIPv4 look ups are done', done)
    if (done[0] != done[1]) {
      // try 2 random services again
      getPublicIPv4_retries++
      // FIXME was 10, add CLI option to up this for CI
      if (getPublicIPv4_retries > 50) {
        console.error('NAT detection: Can\'t determine public IP address')
        process.exit()
      }
      log(done[0], 'not equal to', done[1], 'retrying attempt #', getPublicIPv4_retries)
      getPublicIPv4(cb)
    } else {
      // return
      //log("found public IP", done[0])
      if (cb) cb(done[0])
      doneResolver(done[0])
    }
  }

  function doCall(number) {
    httpGet(publicIpServices[service[number]].url, function (ip) {
      if (ip === false) {
        service[number] = (Math.random() * publicIpServices.length)
        // retry
        console.warn(publicIpServices[service[number]].url, 'failed, retrying')
        doCall(number)
        return
      }
      // console.log(number, publicIpServices[service[number]].url, ip)
      markDone(number, ip)
    })
  }
  doCall(0)
  doCall(1)
  return donePromise
}

function portIsFree(ip, port, cb) {
  const server = net.createServer((socket) => {
  })
  server.on('error', (err) => {
    if (err.code != 'EADDRINUSE') console.error('portIsFree', err)
    cb(false)
  })
  server.listen(port, ip, () => {
    // port is free
    server.close(function() {
      cb(true)
    })
  })
}

// used for generating temp filenames
function randomString(len) {
  var text = ""
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (var i = 0; i < len; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  return text
}

function isDnsPort(ip, port, cb) {
  const resolver = new dns.Resolver()
  resolver.setServers([ip + ':' + port])
  resolver.resolve(auto_config_test_host, function (err, records) {
    if (err) console.error('resolve error:', err)
    log(auto_config_test_host, records)
    cb(records !== undefined)
  })
}

function testDNSForBelnet(server, cb) {
  const resolver = new dns.Resolver()
  resolver.setServers([server])
  // incase server is 127.0.0.1:undefined
  try {
    resolver.resolve('localhost.beldex', function (err, records) {
      if (err) console.error('NETWORK: localhost.beldex resolve err:', err)
      //log(server, 'localhost.beldex test results', records)
      cb(records)
    })
  } catch (e) {
    console.error('NETWORK: testDNSForBelnet error, incorrect server?', server)
    cb()
  }
}

function lookup(host, cb) {
  var resolver = new dns.Resolver()
  console.log('lookuping', host, 'against servers', runningConfig.dns.bind)
  resolver.setServers([runningConfig.dns.bind])
  resolver.resolve(host, function (err, records) {
    if (err) {
      // not as bad... that's at least a properly formatted response
      if (err.code == 'ENOTFOUND') {
        records = null
      } else
        // leave bad
        if (err.code == 'ETIMEOUT') {
          records = undefined
        } else {
          console.error('belnet lookup unknown err', err)
        }
    }
    console.log(host, 'belnet dns test results', records)
    cb(records)
  })
}

function findBelNetDNS(cb) {
  const localIPs = getBoundIPv4s()
  var checksLeft = 0
  var servers = []
  function checkDone() {
    if (shuttingDown) {
      //if (cb) cb()
      log('not going to start belnet, shutting down')
      return
    }
    checksLeft--
    if (checksLeft <= 0) {
      log('readResolv done')
      cb(servers)
    }
  }
  /*
  var resolvers = dns.getServers()
  console.log('Current resolvers', resolvers)
  // check local DNS servers in resolv config
  for(var i in resolvers) {
    const server = resolvers[i]
    var idx = localIPs.indexOf(server)
    if (idx != -1) {
      // local DNS server
      console.log('local DNS server detected', server)
      checksLeft++
      testDNSForBelnet(server, function(isBelnet) {
        if (isBelnet) {
          // belnet
          console.log(server, 'is a belnet DNS server')
          servers.push(server)
        }
        checkDone()
      })
    }
  }
  */
  // maybe check all local ips too
  for (var i in localIPs) {
    const server = localIPs[i]
    checksLeft++
    testDNSForBelnet(server, function (isBelnet) {
      if (isBelnet !== undefined) {
        // belnet
        log(server, 'is a belnet DNS server')
        servers.push(server)
      }
      checkDone()
    })
  }
}

function readResolv(dns_ip, cb) {
  const localIPs = getBoundIPv4s()
  var servers = []
  var checksLeft = 0
  //log('make sure we exclude?', dns_ip)

  function checkDone() {
    if (shuttingDown) {
      //if (cb) cb()
      log('not going to start belnet, shutting down')
      return
    }
    checksLeft--
    //log('readResolv reports left', checksLeft)
    if (checksLeft <= 0) {
      log('readResolv done')
      cb(servers)
    }
  }

  var resolvers = dns.getServers()
  log('Current resolvers', resolvers)
  for (var i in resolvers) {
    const server = resolvers[i]
    if (server == dns_ip) {
      log('preventing DNS loop on', dns_ip)
      continue
    }
    var idx = localIPs.indexOf(server)
    if (idx != -1) {
      log('local DNS server detected', server)
      checksLeft++ // wait for it
      testDNSForBelnet(server, function (isBelnet) {
        if (isBelnet === undefined) {
          // not belnet
          log(server, 'is not a belnet DNS server')
          // FIXME: but did we actually get a response
          // is it a valid dns server?
          servers.push(server)
        }
        checkDone()
      })
    } else {
      // non-local
      log('found remote DNS server', server)
      servers.push(server)
    }
  }
  checksLeft++
  checkDone()
  /*
  const data = fs.readFileSync('/etc/resolv.conf', 'utf-8')
  const lines = data.split(/\n/)

  for(var i in lines) {
    var line = lines[i].trim()
    if (line.match(/#/)) {
      var parts = line.split(/#/)
      line = parts[0].trim()
    }
    // done reducing
    if (!line) continue
    if (line.match(/^nameserver /)) {
      const server = line.replace(/^nameserver /, '')
      var idx = localIPs.indexOf(server)
      if (idx != -1) {
        console.log('local DNS server detected', server)
        const resolver = new dns.Resolver()
        resolver.setServers([server])
        checksLeft++
        resolver.resolve('localhost.beldex', function(err, records) {
          //if (err) console.error(err)
          //console.log('local dns test results', records)
          if (records === undefined) {
            // not belnet
            console.log(server, 'is not a belnet DNS server')
            servers.push(server)
          }
          checkDone()
        })
      } else {
        // non-local
        console.log('found remote DNS server', server)
        servers.push(server)
      }
      continue
    }
    checkDone()
    console.error('readResolv unknown', line)
  }
  return servers
  */
}

// this can really delay the start of belnet
function findFreePort53(ips, index, cb) {
  log('testing', ips[index], 'port 53')
  isDnsPort(ips[index], 53, function (res) {
    //console.log('isDnsPort res', res)
    // false
    if (!res) {
      log('Found free port 53 on', ips[index], index)
      cb(ips[index])
      return
    }
    log('Port 53 is not free on', ips[index], index)
    if (index + 1 == ips.length) {
      cb()
      return
    }
    findFreePort53(ips, index + 1, cb)
  })
}

// https://stackoverflow.com/a/40686853
function mkDirByPathSync(targetDir, { isRelativeToScript = false } = {}) {
  const sep = path.sep
  const initDir = path.isAbsolute(targetDir) ? sep : ''
  const baseDir = isRelativeToScript ? __dirname : '.'

  return targetDir.split(sep).reduce((parentDir, childDir) => {
    const curDir = path.resolve(baseDir, parentDir, childDir)
    try {
      fs.mkdirSync(curDir)
    } catch (err) {
      if (err.code === 'EEXIST') { // curDir already exists!
        return curDir
      }

      // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
      if (err.code === 'ENOENT') { // Throw the original parentDir error on curDir `ENOENT` failure.
        throw new Error(`EACCES: permission denied, mkdir '${parentDir}'`)
      }

      const caughtErr = ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1
      if (!caughtErr || caughtErr && curDir === path.resolve(targetDir)) {
        throw err // Throw if it's just the last created dir.
      }
    }

    return curDir
  }, initDir)
}

function makeMultiplatformPath(path) {
  return path
}

var cleanUpBootstrap = false
var cleanUpIni = false
function generateINI(config, need, markDone, cb) {
  const homeDir = os.homedir()
  //console.log('homeDir', homeDir)
  //const data = fs.readFileSync(homeDir + '/.belnet/belnet.ini', 'utf-8')
  //const jConfig = iniToJSON(data)
  //console.dir(jConfig)
  //const iConfig = jsonToINI(jConfig)
  //console.log(iConfig)
  var upstreams, belnet_free53Ip, belnet_nic
  var use_belnet_rpc_port = config.rpc_port
  var belnet_bootstrap_path = homeDir + '/.belnet/bootstrap.signed'
  var belnet_nodedb = homeDir + '/.belnet/netdb'
  if (config.data_dir) {
    belnet_nodedb = config.data_dir + '/netdb'
  }
  if (config.netdb) {
    belnet_nodedb = config.netdb + '/netdb'
  }
  if (config.netid) {
    belnet_nodedb += '-' + config.netid
  }
  if (config.data_dir && !fs.existsSync(config.data_dir)) {
    log('making', config.data_dir)
    mkDirByPathSync(config.data_dir)
  }
  if (belnet_nodedb && !fs.existsSync(belnet_nodedb)) {
    log('making', belnet_nodedb)
    mkDirByPathSync(belnet_nodedb)
  }
  var upstreamDNS_servers = []
  var params = {
    upstreamDNS_servers: upstreamDNS_servers,
    belnet_free53Ip: belnet_free53Ip,
    belnet_nodedb: belnet_nodedb,
    belnet_bootstrap_path: belnet_bootstrap_path,
    belnet_nic: belnet_nic,
    use_belnet_rpc_port: use_belnet_rpc_port,
  }
  if (config.bootstrap_url) {
    httpGet(config.bootstrap_url, function (bootstrapData) {
      if (bootstrapData) {
        cleanUpBootstrap = true
        const tmpRcPath = os.tmpdir() + '/' + randomString(8) + '.belnet_signed'
        fs.writeFileSync(tmpRcPath, bootstrapData, 'binary')
        log('boostrap wrote', bootstrapData.length, 'bytes to', tmpRcPath)
        //belnet_bootstrap_path = tmpRcPath
        params.belnet_bootstrap_path = tmpRcPath
        config.bootstrap_path = tmpRcPath
      }
      markDone('bootstrap', params)
    })
  } else {
    // seed version (also non-url version?)
    //params.belnet_bootstrap_path = ''
    markDone('bootstrap', params)
  }
  readResolv(config.dns_ip, function (servers) {
    upstreamDNS_servers = servers
    params.upstreamDNS_servers = servers
    upstreams = 'upstream=' + servers.join('\nupstream=')
    markDone('upstream', params)
  })
  // check for belnet RPC port
  log('trying', 'http://' + config.rpc_ip + ':' + config.rpc_port)
  httpGet('http://' + config.rpc_ip + ':' + config.rpc_port, function (testData) {
    //log('rpc has', testData)
    if (testData !== undefined) {
      log('Bumping RPC port', testData)
      // FIXME: retest new port
      use_belnet_rpc_port = use_belnet_rpc_port + 1
      params.use_belnet_rpc_port = use_belnet_rpc_port
    }
    markDone('rpcCheck', params)
  })
  var skipDNS = false
  if (config.dns_ip || config.dns_port) {
    skipDNS = true
    markDone('dnsBind', params)
  }
  getNetworkIP(function (e, ip) {
    if (ip == 'error' || !ip) {
      console.error('NETWORK: can\'t detect default adapter IP address')
      // can't handle the exits here because we don't know if it's an actual requirements
      // if we need netIf or dnsBind
      if (done.netIf !== undefined || done.dnsBind !== undefined) {
        process.exit(1)
      }
    }
    log('detected outgoing interface ip', ip)
    belnet_nic = getIfNameFromIP(ip)
    params.belnet_nic = belnet_nic
    params.interfaceIP = ip
    log('detected outgoing interface', belnet_nic)
    markDone('netIf', params)
    if (skipDNS) return
    var tryIps = ['127.0.0.1']
    if (os.platform() == 'linux') {
      tryIps = ['127.3.2.1', '127.0.0.1']
    }
    tryIps.push(ip)
    findFreePort53(tryIps, 0, function (free53Ip) {
      if (free53Ip === undefined) {
        console.error('NETWORK: Cant automatically find an IP to put a belnet DNS server on')
        // can't handle the exits here because we don't know if it's an actual requirements
        if (need.dnsBind !== undefined) {
          process.exit(1)
        }
      }
      belnet_free53Ip = free53Ip
      params.belnet_free53Ip = free53Ip
      log('binding DNS port 53 to', free53Ip)
      markDone('dnsBind', params)
    })
  })
  getPublicIPv4(function (ip) {
    //log('generateINI - ip', ip)
    params.publicIP = ip
    markDone('publicIP', params)
  })
}

// unified post auto-config adjustments
// disk to running
function applyConfig(file_config, config_obj) {
  // bootstrap section
  // router mode: bootstrap is optional (might be a seed if not)
  // client mode: bootstrap is required, can't have a seed client
  if (file_config.bootstrap_path) {
    config_obj.bootstrap = {
      'add-node': file_config.bootstrap_path
    }
  }
  // connect section
  if (file_config.connects) {
    if (config_obj.connect === undefined) config_obj.connect = {}
    for(var k in file_config.connects) {
      config_obj.connect[k] = file_config.connects[k]
    }
  }
  // router section
  if (file_config.nickname) {
    config_obj.router.nickname = file_config.nickname
  }
  if (file_config.transport_privkey) {
    config_obj.router['transport-privkey'] = file_config.transport_privkey
  }
  if (file_config.encryption_privkey) {
    config_obj.router['encryption-privkey'] = file_config.encryption_privkey
  }
  if (file_config.ident_privkey) {
    config_obj.router['ident-privkey'] = file_config.ident_privkey
  }
  if (file_config.contact_file) {
    config_obj.router['contact-file'] = file_config.contact_file
  }
  // set default netid based on testnet
  if (file_config.beldexd && file_config.beldexd.network == "test") {
    config_obj.router.netid = 'gamma'
    //runningConfig.network['ifaddr'] = '10.254.0.1/24' // hack for Ryan's box
  }
  if (file_config.netid) {
    config_obj.router.netid = file_config.netid
  }
  // network section
  if (file_config.profiling_file) {
    if (config_obj.network === undefined) config_obj.network = {}
    config_obj.network.profiles = file_config.profiling_file
  }
  // just pass through (truish/falsish flag)
  if (file_config.profiling) {
    config_obj.network.profiling = file_config.profiling
  }
  if (file_config.ifname) {
    if (config_obj.network === undefined) config_obj.network = {}
    config_obj.network.ifname = file_config.ifname
  }
  if (file_config.ifaddr) {
    if (config_obj.network === undefined) config_obj.network = {}
    config_obj.network.ifaddr = file_config.ifaddr
  }
  // logging section
  if (file_config.log_path) {
    // make sure section is created
    if (config_obj.logging === undefined) config_obj.logging = {}
    config_obj.logging.file = file_config.log_path
  }
  // metrics section
  if (file_config.metrics_path) {
    // make sure section is created
    if (config_obj.metrics === undefined) config_obj.metrics = {}
    config_obj.metrics['json-metrics-path'] = file_config.metrics_path + '/metrics.json'
  }
  // dns section
  if (file_config.dns_ip || file_config.dns_port) {
    // FIXME: dynamic dns ip
    // we'd have to move the DNS autodetection here
    //   detect free port 53 on ip
    // for now just make sure we have sane defaults
    var ip = file_config.dns_ip
    if (!ip) ip = '127.0.0.1'
    var dnsPort = file_config.dns_port
    if (dnsPort === undefined) dnsPort = 53
    config_obj.dns.bind = ip + ':' + dnsPort
  }
  // api section
  if (file_config.rpc_ip === false) {
    config_obj.api.enabled = false
  }
}

var runningConfig = {}
var genSnCallbackFired // a lock to make sure we only have one callback inflight at a time
function generateSerivceNodeINI(config, cb) {
  const homeDir = os.homedir()
  var done = {
    bootstrap: false,
    upstream: false,
    rpcCheck: false,
    dnsBind: false,
    netIf: false,
    publicIP: false,
  }
  if (config.publicIP) {
    done.publicIP = undefined
  }
  genSnCallbackFired = false
  function markDone(completeProcess, params) {
    done[completeProcess] = true
    let ready = true
    for (var i in done) {
      if (!done[i]) {
        ready = false
        log(i, 'is not ready')
        break
      }
    }
    if (shuttingDown) {
      //if (cb) cb()
      log('not going to start belnet, shutting down')
      return
    }
    if (!ready) return
    // we may have un-required proceses call markDone after we started
    if (genSnCallbackFired) return
    genSnCallbackFired = true
    /*
    var keyPath = homeDir + '/.beldex/'
    //
    if (config.beldexd && config.beldexd.data_dir) {
      keyPath = config.beldexd.data_dir
      // make sure it has a trailing slash
      if (keyPath[keyPath.length - 1] != '/') {
        keyPath += '/'
      }
    }
    if (config.beldexd &&
         (config.beldexd.network == "test" || config.beldexd.network == "demo")) {
      keyPath += 'testnet/'
    }
    keyPath += 'key'
    */
    log('markDone params', JSON.stringify(params))
    log('PUBLIC', params.publicIP, 'IFACE', params.interfaceIP)
    var useNAT = false
    if (params.publicIP != params.interfaceIP) {
      log('NAT DETECTED MAKE SURE YOU FORWARD UDP PORT', config.public_port, 'on', params.publicIP, 'to', params.interfaceIP)
      useNAT = true
    }
    log('Drafting belnet master node config')
    runningConfig = {
      router: {
        threads: 4,
        'min-routers': 6,
        'max-routers': 60,
      },
      dns: {
        upstream: params.upstreamDNS_servers,
        bind: params.belnet_free53Ip + ':53',
      },
      logging: {
        level: 'info',
      }, /*
      metrics: {
        json-metrics-path:
      }, */
      netdb: {
        dir: params.belnet_nodedb,
      },
      bind: {
        // will be set after
      },
      network: {
        enabled: true,
        //profiling: false,
        exit: false
      },
      api: {
        enabled: true,
        bind: config.rpc_ip + ':' + params.use_belnet_rpc_port
      },
      system: {
        user: '_belnet',
        group: '_beldex'
      }
    }
    if (config.beldexd) {
      runningConfig.beldexd = {
        enabled: true,
        jsonrpc: config.beldexd.rpc_ip + ':' + config.beldexd.rpc_port,
        //username: config.beldexd.rpc_user,
        //password: config.beldexd.rpc_pass,
        //'master-node-seed': keyPath
      }
      if (config.beldexd.rpc_user) {
        runningConfig.beldexd.username = config.beldexd.rpc_user
        runningConfig.beldexd.password = config.beldexd.rpc_pass
      }
    }
    if (useNAT) {
      runningConfig.router['public-ip'] = params.publicIP
      runningConfig.router['public-port'] = config.public_port
    }
    // NAT is only used for routers...
    // inject manual NAT config?
    if (config.public_ip) {
      runningConfig.router['public-ip'] = config.public_ip
      runningConfig.router['public-port'] = config.public_port
    }
    if (config.forceNatOff) {
      delete runningConfig.router['public-ip']
      delete runningConfig.router['public-port']
    }
    runningConfig.bind[params.belnet_nic] = config.public_port
    if (config.internal_port) {
      runningConfig.bind[params.belnet_nic] = config.internal_port
    }
    applyConfig(config, runningConfig)
    // not in seedMode, make sure we have some way to bootstrap
    if (!config.seedMode && !runningConfig.bootstrap && !runningConfig.connect) {
      console.error()
      console.error('NETWORK: ERROR! No bootstrap or connects and not in seedMode')
      console.error()
      // should this be shutdown_everything?
      process.exit(1)
    }

    // doesn't work
    //runningConfig.network['type'] = 'null' // disable exit
    //runningConfig.network['enabled'] = true
    cb(ini.jsonToINI(runningConfig))
  }
  generateINI(config, done, markDone, cb)
}

var genClientCallbackFired
function generateClientINI(config, cb) {
  var done = {
    bootstrap: false,
    upstream: false,
    rpcCheck: false,
    dnsBind: false,
  }
  genClientCallbackFired = false
  function markDone(completeProcess, params) {
    done[completeProcess] = true
    let ready = true
    for (var i in done) {
      if (!done[i]) {
        ready = false
        log(i, 'is not ready')
        break
      }
    }
    if (!ready) return
    // make sure we didn't already start
    if (genClientCallbackFired) return
    genClientCallbackFired = true
    if (!params.use_belnet_rpc_port) {
      // use default because we enable it
      params.use_belnet_rpc_port = 1190
    }
    log('Drafting belnet client config')
    runningConfig = {
      router: {
        nickname: 'ldl',
      },
      dns: {
        upstream: params.upstreamDNS_servers,
        bind: params.belnet_free53Ip + ':53',
      },
      netdb: {
        dir: params.belnet_nodedb,
      },
      network: {
      },
      api: {
        enabled: true,
        bind: config.rpc_ip + ':' + params.use_belnet_rpc_port
      },
    }
    applyConfig(config, runningConfig)
    // a bootstrap is required, can't have a seed client
    if (!runningConfig.bootstrap && !runningConfig.connect) {
      console.error('no bootstrap or connects for client')
      process.exit(1)
    }
    cb(ini.jsonToINI(runningConfig))
  }
  generateINI(config, done, markDone, cb)
}

var shuttingDown
var belnet
var belnetLogging = true
function preLaunchBelnet(config, cb) {
  //console.log('userInfo', os.userInfo('utf8'))
  //console.log('started as', process.getuid(), process.geteuid())

  // check user permissions
  if (os.platform() == 'darwin') {
    if (process.getuid() != 0) {
      console.error('MacOS requires you start this with sudo')
      process.exit(1)
    }
    // leave the linux commentary for later
    /*
    } else {
      if (process.getuid() == 0) {
        console.error('Its not recommended you run this as root')
      } */
  }

  // belnet will crash if this file is zero bytes
  if (fs.existsSync('profiles.dat')) {
    var stats = fs.statSync('profiles.dat')
    if (!stats.size) {
      log('cleaning corrupt router track record file')
      fs.unlinkSync('profiles.dat')
    }
  }

  const tmpDir = os.tmpdir()
  const tmpPath = tmpDir + '/' + (config.nickname ? config.nickname + '_' : '') +
   randomString(8) + '.belnet_ini'
  cleanUpIni = true
  config.ini_writer(config, function (iniData) {
    if (shuttingDown) {
      //if (cb) cb()
      log('not going to write belnet config, shutting down')
      return
    }
    log(iniData, 'as', tmpPath)
    fs.writeFileSync(tmpPath, iniData)
    config.ini_file = tmpPath
    cb()
  })
  return tmpPath
}

function launchBelnet(config, instance, cb) {
  if (shuttingDown) {
    //if (cb) cb()
    log('not going to start belnet, shutting down')
    return
  }
  var networkConfig = config.network;
  if (!fs.existsSync(networkConfig.ini_file)) {
    log('belnet config file', networkConfig.ini_file, 'does not exist')
    process.exit(1)
  }
  // command line options
  var cli_options = [networkConfig.ini_file]
  if (networkConfig.verbose) {
    cli_options.push('-v')
  }
  log('launching', networkConfig.binary_path, cli_options.join(' '))
  try {
    belnet = spawn(networkConfig.binary_path, cli_options)
  } catch(e) {
    console.error(e)
    // debug EPERM
    if (e.code === 'EPERM') {
      console.log('this usually means your host doesn\'t have enough permissions for belnet. Outputting additional debug information for developers:')
      console.log(execSync('ls -la ' + networkConfig.binary_path).toString())
      console.log(execSync('getcap ' + networkConfig.binary_path).toString())
      console.log(execSync('ls -la /dev/net').toString())
    }
  }

  if (!belnet) {
    console.error('failed to start belnet, failing...')
    // proper shutdown?
    process.exit(1)
  }
  // log('started as', belnet.pid)
  belnet.blockchainFailures = {}
  belnet.startTime = Date.now()
  belnet.killed = false
  belnet.stdout.on('data', (data) => {
    var lines = data.toString().split(/\n/)
    for(var i in lines) {
      var tline = lines[i].trim()
      //belnet-0.4.0-59e6a4bc (dev build)
      if (tline.match('belnet-0.')) {
        var parts = tline.split('belnet-0.')
        belnet_version = parts[1]
        fs.writeFileSync(config.launcher.var_path + '/belnet.version', belnet_version + "\n")
      }
      // initalized master node: 7y95hnx8rrr1egfebpysntg5duh3dx5o1x7wycug99tjan19oejo.mnode
      if (tline.match('initalized master node: ')) {
        var parts = tline.split('initalized master node: ')
        belnet_mnode = parts[1]
        fs.writeFileSync(config.launcher.var_path + '/mnode_address', belnet_mnode + "\n")
      }
      // in case we fix the spelling in the future
      if (tline.match('initialized master node: ')) {
        var parts = tline.split('initialized master node: ')
        belnet_mnode = parts[1]
        fs.writeFileSync(config.launcher.var_path + '/mnode_address', belnet_mnode + "\n")
      }
    }
    const last = lines.pop()
    if (0 && last.trim()) {
      console.log('belnet.js onData - stripping [' + last + ']')
    }
    data = lines.join('\n')
    if (module.exports.onMessage) {
      module.exports.onMessage(data)
    }
  })

  belnet.stderr.on('data', (data) => {
    if (module.exports.onError) {
      module.exports.onError(data)
    }
  })

  belnet.on('close', (code, signal) => {
    log(`belnet process exited with code ${code}/${signal} after`, (Date.now() - belnet.startTime)+'ms')
    // code 0 means clean shutdown
    belnet.killed = true
    if (networkConfig.onStop) {
      networkConfig.onStop(config, instance, belnet)
    }
    if (!shuttingDown) {
      if (networkConfig.restart) {
        // restart it in 30 seconds to avoid pegging the cpu
        instance.restarts++
        setTimeout(function () {
          log('shutdown has not been requested, restarting belnet, there has been', instance.restart, 'restart(s)')
          launchBelnet(config, instance)
        }, 30 * 1000)
      } else {
        // don't restart...
        // clean up
        // if we have a temp bootstrap, clean it
        if (cleanUpBootstrap && runningConfig.bootstrap['add-node'] && fs.existsSync(runningConfig.bootstrap['add-node'])) {
          fs.unlinkSync(runningConfig.bootstrap['add-node'])
        }
        if (cleanUpIni && fs.existsSync(networkConfig.ini_file)) {
          fs.unlinkSync(networkConfig.ini_file)
        }
      }
    }
    // else we're shutting down
  })
  // we need to update pids!
  if (networkConfig.onStart) {
    networkConfig.onStart(config, instance, belnet)
  }
  if (cb) cb()
}

function getBinaryPath(bin) {
  // from (MIT) https://github.com/springernature/hasbin/blob/master/lib/hasbin.js
  function getPaths(bin) {
    var envPath = (process.env.PATH || '')
    var envExt = (process.env.PATHEXT || '')
    return envPath.replace(/["]+/g, '').split(path.delimiter).map(function (chunk) {
      return envExt.split(path.delimiter).map(function (ext) {
        return path.join(chunk, bin + ext)
      })
    }).reduce(function (a, b) {
      return a.concat(b)
    })
  }
  const paths = getPaths(bin)
  var found = false
  for(const path of paths) {
    if (fs.existsSync(path)) {
      found = path
      break
    }
  }
  return found
}

// call in startServiceNode
function checkConfig(config) {
  //console.trace('belnet checkConfig')
  if (config === undefined) config = {}

  if (config.auto_config_test_ips === undefined) config.auto_config_test_ips = ['1.1.1.1', '72.21.211.176']
  if (config.auto_config_test_host === undefined) config.auto_config_test_host = 'www.imdb.com'
  if (config.auto_config_test_port === undefined) config.auto_config_test_port = 80
  auto_config_test_port = config.auto_config_test_port
  auto_config_test_host = config.auto_config_test_host
  auto_config_test_ips = config.auto_config_test_ips

  if (config.binary_path === undefined) config.binary_path = '/opt/beldex-launcher/bin/belnet'

  // we don't always want a bootstrap (seed mode)

  // maybe if no port we shouldn't configure it
  if (config.rpc_ip === undefined) config.rpc_ip = '127.0.0.1'
  if (config.rpc_port === undefined) config.rpc_port = 0

  // set public_port ?
  if (os.platform() == 'linux') {
    // not root-like
    const found = getBinaryPath('getcap')
    //console.log('found getcap at', found)
    if (!found) {
      console.log('You do not have getcap (and likely missing setcap too), if you are on a debian-based OS, please install the libcap2-bin package')
      console.warn('belnet will not work as a non-root user without this utility')
      return
    }
    exec('getcap ' + config.binary_path, function (err, stdout, stderr) {
      //console.log('getcap stdout', stdout)
      // src/beldex-network/belnet = cap_net_bind_service,cap_net_admin+eip
      if (!(stdout.match(/cap_net_bind_service/) && stdout.match(/cap_net_admin/))) {
        if (process.getgid() != 0) {
          console.error('')
          console.error(config.binary_path, 'does not have the correct setcap permissions: ', stdout)
          console.error('Please run: "sudo beldex-launcher fix-perms', os.userInfo().username, '" one time, so we can fix permissions on this binary!')
          console.error('shutting down...')
          console.error('')
          process.exit(1)
        } else {
          // are root
          log('going to try to setcap your binary, so you dont need root')
          exec('setcap cap_net_admin,cap_net_bind_service=+eip ' + config.binary_path, function (err, stdout, stderr) {
            if (err) console.error('upgrade err', err)
            else log('binary permissions upgraded')
            //console.log('stdout', stdout)
            //console.log('stderr', stderr)
          })
        }
      }
    })
  }
}

function waitForUrl(url, cb) {
  // console.log('belnet.js - waiting for', url)
  httpGet(url, function (data) {
    //console.log('rpc data', data)
    // will be undefined if down (ECONNREFUSED)
    // if success
    // <html><head><title>Unauthorized Access</title></head><body><h1>401 Unauthorized</h1></body></html>
    if (data) {
      // console.log(url, 'is active')
      return cb()
    }
    // no data could me 404
    if (shuttingDown) {
      //if (cb) cb()
      log('not going to start belnet, shutting down')
      return
    }
    setTimeout(function () {
      waitForUrl(url, cb)
    }, 1000)
  })
}

function startServiceNode(config, cb) {
  var networkConfig = config.network;
  checkConfig(networkConfig)
  networkConfig.ini_writer = generateSerivceNodeINI
  networkConfig.restart = true
  // FIXME: check for bootstrap stomp and strip it
  // only us belnet devs will need to make our own seed node
  var configFile = preLaunchBelnet(networkConfig, function () {
    /*
    if (networkConfig.beldexd === undefined) {
      // belnet only version
      console.log('not waiting for beldexd RPC')
      launchBelnet(config, { restarts: 0 }, cb)
      return
    }
    */
    // test beldexd rpc port first
    // also this makes sure the service key file exists
    var url = 'http://'
    if (networkConfig.beldexd.rpc_user) {
      url += networkConfig.beldexd.rpc_user+':'+networkConfig.beldexd.rpc_pass+'@'
    }
    url += networkConfig.beldexd.rpc_ip+':'+networkConfig.beldexd.rpc_port+'/json_rpc'
    log('belnet waiting for beldexd RPC server')
    waitForUrl(url, function () {
      launchBelnet(config, { restarts: 0 }, cb)
    })
  })
  return configFile
}

function startClient(config, cb) {
  var networkConfig = config.network;
  checkConfig(networkConfig)
  if (networkConfig.bootstrap_path === undefined && networkConfig.connects === undefined &&
     networkConfig.bootstrap_url === undefined) {
    if (config.beldexd &&
         (config.beldexd.network == "test" || config.beldexd.network == "demo")) {
      networkConfig.bootstrap_url = 'https://seed.belnet.org/testnet.signed'
    } else {
      networkConfig.bootstrap_url = 'https://seed.belnet.org/belnet.signed'
    }
  }
  networkConfig.ini_writer = generateClientINI
  var configFile = preLaunchBelnet(networkConfig, function () {
    launchBelnet(config, { restarts: 0 }, cb)
  })
  return configFile
}

// return a truish value if so
function isRunning() {
  // should we block until port is responding?
  return belnet
}

// copied from lib
function isPidRunning(pid) {
  if (pid === undefined) {
    console.trace('isPidRunning was passed undefined, reporting not running')
    return false
  }
  try {
    process.kill(pid, 0)
    //console.log('able to kill', pid)
    return true
  } catch (e) {
    if (e.code == 'ERR_INVALID_ARG_TYPE') {
      // means pid was undefined
      return true
    }
    if (e.code == 'ESRCH') {
      // not running
      return false
    }
    if (e.code == 'EPERM') {
      // we're don't have enough permissions to signal this process
      return true
    }
    console.log(pid, 'isRunning', e.code)
    return false
  }
  return false
}

// intent to stop belnet and don't restart it
var retries = 0
function stop() {
  shuttingDown = true
  // if belnet isn't started, we get more than 3 retries
  if (belnet && belnet.killed) {
    console.warn('belnet already stopped')
    retries++
    if (retries > 3) {
      // 3 exits in a row, something isn't dying
      // just quit out
      process.exit()
    }
    return
  }
  // output on each stop request...
  if (belnetLogging) log('requesting belnet be shutdown')
  if (belnet && !belnet.killed) {
    log('sending SIGINT to belnet', belnet.pid)
    try {
      process.kill(belnet.pid, 'SIGINT')
    } catch(e) {
    }
    belnet.killed = true
    // HACK: belnet on macos can not be killed if rpc port is in use
    var monitorTimerStart = Date.now()
    var monitorTimer = setInterval(function () {
      if (!isPidRunning(belnet.pid)) {
        // launcher can't exit until this interval is cleared
        clearInterval(monitorTimer)
      } else {
        var diff = Date.now() - monitorTimerStart
        if (diff > 15 * 1000) {
          // reach 15 secs and belnet is still running
          // escalate it
          console.error('Belnet is still running 15s after we intentionally stopped belnet?')
          try {
            process.kill(belnet.pid, 'SIGKILL')
          } catch(e) {
          }
        } else
          if (diff > 30 * 1000) {
            // reach 30 secs and belnet is still running
            // escalate it
            console.error('Belnet is still running 30s after we intentionally killed belnet?')
            var handles = process._getActiveHandles()
            console.log('handles', handles.length)
            for (var i in handles) {
              var handle = handles[i]
              console.log(i, 'type', handle._type, handle)
            }
            console.log('requests', process._getActiveRequests().length)
            console.log('forcing exit')
            process.exit()
          }
      }
    }, 1000)
    // a setTimeout 15s will stop the system from shutting down
    /*
    setTimeout(function() {
      try {
        // check to see if still running
        process.kill(belnet.pid, 0)
        log('sending SIGKILL to belnet')
        process.kill(belnet.pid, 'SIGKILL')
      } catch(e) {
        console.error('Launcher is still running 15s after we intentionally stopped belnet?')
        var handles = process._getActiveHandles()
        console.log('handles', handles.length)
        for(var i in handles) {
          var handle = handles[i]
          console.log(i, 'type', handle._type, handle)
        }
        console.log('requests', process._getActiveRequests().length)
        process.exit()
      }
    }, 15 * 1000)
    */
  }
}

// isRunning covers this too well
function getPID() {
  return (belnet && !belnet.killed && belnet.pid) ? belnet.pid : 0
}

// FIXME, which belnet client??
// but retains setting between restarts...
function enableLogging() {
  belnetLogging = true
}

function disableLogging(quiet = false) {
  if (!quiet) console.log('Disabling belnet logging')
  belnetLogging = false
}

function getBelNetIP(cb) {
  function checkDNS() {
    log('belnet seems to be running, querying', runningConfig.dns.bind)
    // where's our DNS server?
    //log('RunningConfig says our belnet\'s DNS is on', runningConfig.dns.bind)
    testDNSForBelnet(runningConfig.dns.bind, function (ips) {
      //log('belnet test', ips)
      if (ips && ips.length) {
        cb(ips[0])
      } else {
        // , retrying
        console.error('cant communicate with belnet DNS')
        /*
        //process.exit()
        setTimeout(function() {
          getBelNetIP(cb)
        }, 1000)
        */
        cb()
      }
    })
  }
  if (runningConfig.api && runningConfig.api.enabled) {
    log('wait for belnet startup', runningConfig.api)
    var url = 'http://' + runningConfig.api.bind + '/'
    waitForUrl(url, function () {
      checkDNS()
    })
  } else {
    checkDNS()
  }
}

module.exports = {
  startServiceNode: startServiceNode,
  startClient: startClient,
  checkConfig: checkConfig,
  findBelNetDNS: findBelNetDNS,
  lookup: lookup,
  isRunning: isRunning,
  getBelnetDaemonObj: function () { return belnet },
  stop: stop,
  getBelNetIP: getBelNetIP,
  enableLogging: enableLogging,
  disableLogging: disableLogging,
  getPID: getPID,
  // network utils (that maybe shouldn't be here)
  getPublicIPv4: getPublicIPv4,
  getBoundIPv4s: getBoundIPv4s,
  getNetworkIP: getNetworkIP,
  portIsFree: portIsFree,
  // other functions that should be in lib but they're here for now
  randomString: randomString,
  mkDirByPathSync: mkDirByPathSync, // for daemon
  httpGet: httpGet, // for public-ports

  // FIXME: should we allow hooking of log() too?
  onMessage: function (data) {
    if (belnetLogging) {
      console.log(`belnet: ${data}`)
    }
  },
  onError: function (data) {
    console.log(`belneterr: ${data}`)
  },
  getBinaryPath: getBinaryPath,
}
