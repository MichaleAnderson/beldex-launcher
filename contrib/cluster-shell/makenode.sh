mkdir beldex$1
cd beldex$1
ln -s ../bin/beldexd beldexd$1
ln -s ../bin/belnet belnet$1
ln -s ../bin/httpserver httpserver$1
cp ../beldexX/launcher.ini .
nano launcher.ini
echo "kill -15 `cat beldex$1/launcher.pid`" >> stop.sh
