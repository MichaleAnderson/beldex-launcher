put all binaries (beldexd, belnet, httpserver) into the bin/

copy as many beldexX to beldex2, beldex3, etc as you need (belnet network needs a seed and 4 nodes a minimum)

Then for each beldexX edit the last digit following parameters to make the number of X in launcher.ini
- blockchain.rpc_port
- blockchain.zmq_port
- blockchain.p2p_port
- network.rpc_port
- network.public_port
- network.dns_port
- network.ifname
- network.nickname

also change network.ifaddr changed the 10.142.0.1/24 to 10.14X.0.1/24

personally I like symlinking the binaries into the beldexX with different identifible names, so I can easily tell from ps what command is which copy
```
cd beldexX
ln -s ../bin/beldexd beldexd-serviceX
ln -s ../bin/belnet belnet-serviceX
ln -s ../bin/httpserver httpserver-serviceX
cd ..
```
