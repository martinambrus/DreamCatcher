<?php
namespace martinambrus;

// script timing starts
global $time_start;
$time_start = microtime(true);

require_once './vendor/autoload.php';
require_once './Redis.php';
require_once './RSSFetcher.php';
require_once "./SimplePie.compiled.php";

// if we can't get the RSS feed in the set timeout, then we'll fire up a Redis message saying so and exit
define( 'MAX_TIMEOUT', getenv( 'MAX_FETCH_TIMEOUT' ) );
set_time_limit( ( MAX_TIMEOUT ?? 60 ) );

// if no timezone, set default to Central European
if (!ini_get('date.timezone')) {
  date_default_timezone_set('Europe/Prague');
}

// create a Redis publishing client
try {
  $redis_pub = new Redis( getenv('REDIS_HOSTNAME'), getenv('REDIS_PORT') );
} catch ( \Exception $e ) {
  echo '[' . gmdate( 'j.m.Y H:i:s' ) . '] Exception while trying to connect to Redis via ' . getenv('REDIS_HOSTNAME') . ':' . getenv('REDIS_PORT')."\n";
  echo $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();
  exit;
}

// create the main app instance
global $rss_fetcher;
$rss_fetcher = new RSSFetcher( getenv( 'FEED_URL' ), getenv( 'HOSTNAME' ), $redis_pub );
$rss_fetcher->set_test_run( (bool) getenv( 'TEST_RUN' ) );

// register a function that would log an error if we couldn't get and parse the RSS feed in this script's lifetime
register_shutdown_function( [ $rss_fetcher, 'shutdown' ] );

// parse and exit
$rss_fetcher->parse();