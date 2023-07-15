<?php
require_once './vendor/autoload.php';
use JDecool\JsonFeed\Reader\ReaderBuilder;

// if we can't get the RSS feed in the set timeout, then we'll fire up a REDIS message saying so and exit
define( 'MAX_TIMEOUT', getenv( 'MAX_FETCH_TIMEOUT' ) );
set_time_limit( ( MAX_TIMEOUT ?? 60 ) );

if (!ini_get('date.timezone')) {
  date_default_timezone_set('Europe/Prague');
}

$time_start = microtime(true);

global $feed_url, $fetch_complete;

$fetch_complete = false;
$feed_url = getenv( 'FEED_URL' );

define( 'TEST_RUN', getenv( 'TEST_RUN' ) );
define( 'REDIS_NEW_LINKS_CHANNEL', getenv( 'REDIS_NEW_LINKS_CHANNEL' ) );
define( 'REDIS_LOGS_CHANNEL', getenv( 'REDIS_LOGS_CHANNEL' ) );
define( 'CLIENT_ID', getenv( 'HOSTNAME' ) ?? 'rss_fetch_undefined_host' );
define( 'SERVICE_ID', 'rss-fetch' );

register_shutdown_function( function() {
  global $redis, $feed_url, $fetch_complete;

  if ( !$fetch_complete ) {
    echo 'could not fetch RSS data in ' . MAX_TIMEOUT . ' seconds for ' . $feed_url;
    $redis->publish(REDIS_LOGS_CHANNEL, json_encode([
      'service' => SERVICE_ID,
      'severity' => 'error',
      'code' => $redis->get('ERR_RSS_FETCH_TIMEOUT'),
      'time' => time(),
      'msg' => 'could not fetch RSS data in ' . MAX_TIMEOUT . ' seconds for ' . $feed_url,
    ]));
  }
});

// define a test feed URL if we are performing an initial test run
if ( TEST_RUN ) {
  $feed_url = 'https://news.ycombinator.com/rss';

  // also, sleep for 5 seconds, since the initial REDIS setup takes a moment to populate error codes
  sleep( 5 );
}

require_once "./utils.php";
require_once "./SimplePie.compiled.php";

global $redis;
$redis = new Redis();
//Connecting to Redis
try {
  $redis->connect(getenv('REDIS_HOSTNAME'), getenv('REDIS_PORT'));
} catch ( \Exception $e ) {
  echo '[' . gmdate( 'j.m.Y H:i:s' ) . '] Exception while trying to connect to Redis via ' . getenv('REDIS_HOSTNAME') . ':' . getenv('REDIS_PORT')."\n";
  echo $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();
  exit;
}

if ( !$feed_url ) {
  $msg = 'error: no feed URL passed in ENV variable for rss-fetch';

  $redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
    'service' => SERVICE_ID,
    'severity' => 'error',
    'code' => $redis->get( 'ERR_RSS_FETCH_NO_FEED' ),
    'time' => time(),
    'msg' => $msg,
  ]));

  echo $msg ."\n";

  // set this to true, so we know we've not reached a script timeout
  $fetch_complete = true;
  exit;
} else if ( TEST_RUN ) {
  try {
    // this is here to test Redis publishing, nothing more - the actual channel message isn't being received by anyone
    $redis->publish('TEST_RUN', CLIENT_ID );
  } catch ( \Exception $e ) {
    echo '[' . gmdate( 'j.m.Y H:i:s' ) . '] Exception while trying to publish to Redis (' . getenv('REDIS_HOSTNAME') . ':' . getenv('REDIS_PORT').")\n";
    echo $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();

    // set this to true, so we know we've not reached a script timeout
    $fetch_complete = true;
    exit;
  }
}

// if this feed doesn't have an HTTP or HTTPS prefix, try looking for a working link with one of those prefixes
// and update it if found
if ( mb_strtolower( mb_substr( $feed_url, 0, 7)) != 'http://' && mb_strtolower( mb_substr( $feed_url, 0, 8)) != 'https://' ) {
    // try HTTPS first
    $file_headers = @get_headers( 'https://' . $feed_url );
    if ( $file_headers && !str_contains($file_headers[0], '404 Not Found')) {
      $msg = 'changing invalid feed url' . $feed_url . ' to ' . 'https://' . $feed_url;
      echo $msg . "\n";
      $feed_url = 'https://' . $feed_url;
    } else {
      // try HTTP
      $file_headers = @get_headers( 'http://' . $feed_url );
      if ( $file_headers && !str_contains($file_headers[0], '404 Not Found')) {
        $msg = 'changing invalid feed url' . $feed_url . ' to ' . 'http://' . $feed_url;
        echo $msg . "\n";
        $feed_url = 'http://' . $feed_url;
      } else {
        $msg = 'invalid feed url, unable to parse or fix: ' . $feed_url;
        echo $msg . "\n";

        $redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
          'service' => SERVICE_ID,
          'severity' => 'error',
          'code' => $redis->get( 'ERR_RSS_FETCH_WRONG_URL_CANNOT_FIX' ),
          'time' => time(),
          'msg' => $msg,
        ]));

        // set this to true, so we know we've not reached a script timeout
        $fetch_complete = true;
        exit;
      }
    }

    $redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
      'service' => SERVICE_ID,
      'severity' => 'notice',
      'code' => $redis->get( 'ERR_RSS_FETCH_WRONG_URL' ),
      'result' => $feed_url,
      'time' => time(),
      'msg' => $msg,
    ]));
}

try {
    // fetch the URL via cURL
    $data = fetch_url( $feed_url );

    if (is_array($data)) {
      // throwing here would move us to the catch block with error handling
      throw new \Exception( $data[0] );
    }

    // check that this is not a JSON feed
    $json = json_decode( $data );
    if ($json !== null) {
      // we have a JSON feed - it can still be set to false
      if ($json !== false) {
        $builder = new ReaderBuilder();
        $reader = $builder->build();
        $feed = $reader->createFromJson( $data );

        foreach ($feed->getItems() as $item) {
          // try to extract link image
          $link_img = '';

          if ($item->getImage()) {
            $link_img = $item->getImage();
          } else if ($item->getBannerImage()) {
            $link_img = $item->getBannerImage();
          } else if ($item->getContentHtml()) {
            // check if we can find image in the description
            preg_match_all( '/<img src=["\']([^"\']+)["\'][^>]*>/mi', $item->getContentHtml(), $matches, PREG_SET_ORDER, 0 );
            if ( count( $matches ) ) {
              // use the first available image
              $link_img = $matches[0][1];
            }
          }

          $categories = [];
          if ($item->getTags()) {
            foreach ($item->getTags() as $tag) {
              $categories[] = $tag;
            }
          }

          $author = '';
          if ($item->getAuthor()) {
            if (is_string( $item->getAuthor() )) {
              $author = $item->getAuthor();
            } else if (is_array( $item->getAuthor() )) {
              $author = $item->getAuthor()[0];
            }
          }

          // use current timestamp if we won't be able to find a date
          $date = time();
          if ($item->getDateModified()) {
            $date = $item->getDateModified()->getTimestamp();
          } else if ($item->getDatePublished()) {
            $date = $item->getDatePublished()->getTimestamp();
          }

          $description = $item->getSummary();
          // URL is optional for a JSON feed, so just use ID as a hash
          $url = ($item->getUrl() ?? '#' . $item->getId());

          $feed_item_info = [
            'title'       => ($item->getTitle() ?? $url),
            'description' => $description,
            'link'        => $url,
            'img'         => $link_img,
            'date'        => (is_int($date) ? $date : strtotime( $date )),
            'fetched'     => time(),
          ];

          if ( $author ) {
            $feed_item_info['author'] = $author;
          }

          if ( count( $categories ) ) {
            $feed_item_info['categories'] = $categories;
          }

          $feed_item_info[ 'feed_url' ] = $feed_url;

          $redis->publish( REDIS_NEW_LINKS_CHANNEL, json_encode( $feed_item_info ) );
          $fetch_complete = true;
        }
      }
    } else {
      $feed = get_feed(null, $data);

      if ($feed->error()) {
        // throwing here would move us to the catch block with error handling
        throw new \Exception( $feed->error() );
      }

      // save data into the unprocessed collection
      $items = array_reverse( $feed->get_items() );
      $first_item_stamp = null;
      foreach ($items as $item) {
        // try to extract link image
        $link_img = '';

        // thumbnail found
        if ( $item->get_thumbnail() ) {
          $link_img = $item->get_thumbnail()['url'];
        } else if ( $item->get_enclosures()[0]->thumbnails && count( $item->get_enclosures()[0]->thumbnails ) ) {
          // thumbnail found but not recognized by SimplePie (YouTube)
          $link_img = $item->get_enclosures()[0]->thumbnails[0];
        } else if ( $item->get_enclosures()[0]->link ) {
          // feeds usually provide thumbnails in the link enclosure
          // let's do a super-simple educated guess here
          $image_extensions = array(
            '.jpg',
            '.jpeg',
            '.gif',
            '.png',
            '.bmp',
            '.tif',
            '.tiff'
          );

          if ( in_array( strtolower( strrchr( $item->get_enclosures()[0]->link, '.' ) ), $image_extensions ) ) {
            $link_img = $item->get_enclosures()[0]->link;
          }
        } else {
          // check if we can find image in the description
          preg_match_all( '/<img src=["\']([^"\']+)["\'][^>]*>/mi', $item->get_description(), $matches, PREG_SET_ORDER, 0 );
          if ( count( $matches ) ) {
            // use the first available image
            $link_img = $matches[0][1];
          }
        }

        $categories = [];
        if ( $item->get_categories() ) {
          foreach ( $item->get_categories() as $category ) {
            // check where our title resides
            $title = ( $category->get_label() ? $category->get_label() : $category->get_term() );

            // add category only if a title was actually found
            if ( $title ) {
              $categories[] = $title;
            }
          }
        }

        // only use first author
        $authors = [];
        if ( $item->get_authors() ) {
          foreach ( $item->get_authors() as $author ) {
            $name = $author->get_name();
            // if name is empty, the name could contain an e-mail, in which case, author's name goes into e-mail
            if ( ! $name ) {
              $name = $author->get_email();
            }

            // remove entity tags from author names (http://export.arxiv.org/rss/astro-ph has them stored that way)
            $decoded      = html_entity_decode( $name, ENT_QUOTES || ENT_HTML5, "UTF-8" );
            $tagless      = strip_tags( $decoded );
            $author_final = entities_to_unicode( $tagless );

            if ( $author_final ) {
              $authors[] = $author_final;
            }
          }
        }

        $feed_item_info = [
          'title'        => ($item->get_title() ? untagize( $item->get_title() ) : $item->get_link()),
          'description'  => $item->get_description(),
          'link'         => $item->get_link(),
          'img'          => $link_img,
          'date'         => ( $item->get_date() ? strtotime( $item->get_date() ) : time() ),
          'fetched'      => time(),
        ];

        $first_item_stamp = $feed_item_info['date'];

        if ( count( $authors ) ) {
          $feed_item_info['authors'] = $authors;
        }

        if ( count( $categories ) ) {
          $feed_item_info['categories'] = $categories;
        }

        $feed_item_info[ 'feed_url' ] = $feed_url;

        $redis->publish( REDIS_NEW_LINKS_CHANNEL, json_encode( $feed_item_info ) );
        $fetch_complete = true;
      }
    }
} catch (\Exception $exception) {
  $msg = '(' . $exception->getCode() . ') Error processing "' . $feed_url . '" with message: ' . $exception->getMessage() . ' (file ' . $exception->getFile() . ', line ' . $exception->getLine() .')';

  try {
    $redis->publish(REDIS_LOGS_CHANNEL, json_encode([
      'service' => SERVICE_ID,
      'severity' => 'error',
      'code' => $redis->get( 'ERR_RSS_FETCH_PROCESSING' ),
      'feed_url' => $feed_url,
      'time' => time(),
      'msg' => $msg,
    ]));
  } catch ( \Exception $e ) {
    $msg .= "\n[" . gmdate( 'j.m.Y H:i:s' ) . '] Additional exception found while trying to publish error log to Redis (' . getenv('REDIS_HOSTNAME') . ':' . getenv('REDIS_PORT') . ")\n" . $e->getMessage() . ' in ' . $e->getFile() . ' on line ' . $e->getLine();
  } finally {
    // set this to true, so we know we've not reached a script timeout
    $fetch_complete = true;
  }

  echo $msg ."\n";
  exit;
}

$time_end = microtime(true);
$log_msg = "fetch complete for $feed_url via " . CLIENT_ID . ' in ' . (round($time_end - $time_start,3) * 1000) . 'ms';

// don't publish into log if we're on a test run, so we don't mess up statistics
if ( !TEST_RUN ) {
  $redis->publish(REDIS_LOGS_CHANNEL, json_encode([
    'service' => SERVICE_ID,
    'severity' => 'log',
    'code' => 0,
    'time' => time(),
    'msg' => $log_msg,
  ]));
}

echo "\n\n[" . date('j.m.Y, H:i:s') . "] $log_msg";

if ( TEST_RUN ) {
  echo ', initial test run finished.';
}