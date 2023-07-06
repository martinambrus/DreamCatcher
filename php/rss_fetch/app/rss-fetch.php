<?php
require_once './vendor/autoload.php';
use JDecool\JsonFeed\Reader\ReaderBuilder;

set_time_limit( 3600 );
session_write_close();

if (!ini_get('date.timezone')) {
  date_default_timezone_set('Europe/Prague');
}

$time_start = microtime(true);
$feed_url = getenv( 'FEED_URL' );
define( 'REDIS_NEW_LINKS_CHANNEL', getenv( 'REDIS_NEW_LINKS_CHANNEL' ) );
define( 'REDIS_NEW_LINK_ERRORS_CHANNEL', getenv( 'REDIS_NEW_LINK_ERRORS_CHANNEL' ) );
define( 'REDIS_LOGS_CHANNEL', getenv( 'REDIS_LOGS_CHANNEL' ) );

require_once "./utils.php";
require_once "./SimplePie.compiled.php";

$redis = new Redis();
//Connecting to Redis
$redis->connect( getenv( 'REDIS_HOSTNAME' ), getenv( 'REDIS_PORT' ) );

if ( !$feed_url ) {
  $msg = 'error: no feed URL passed in ENV variable for rss-fetch';

  $redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
    'service' => 'rss-fetch',
    'severity' => 'error',
    'time' => time(),
    'msg' => $msg,
  ]));

  echo $msg ."\n";
  exit;
}

// if this feed doesn't have an HTTP or HTTPS prefix, try looking for a working link with one of those prefixes
// and update it if found
if ( mb_strtolower( mb_substr( $feed_url, 0, 7)) != 'http://' && mb_strtolower( mb_substr( $feed_url, 0, 8)) != 'https://' ) {
    // try HTTPS first
    $file_headers = @get_headers( 'https://' . $feed_url );
    if ( $file_headers && strpos($file_headers[0], '404 Not Found') === false ) {
      echo 'changing invalid feed url' . $feed_url . ' to ' . 'https://' . $feed_url . "<br>\n";
      $feed_url = 'https://' . $feed_url;
    } else {
      // try HTTP
      $file_headers = @get_headers( 'http://' . $feed_url );
      if ( $file_headers && strpos($file_headers[0], '404 Not Found') === false ) {
        echo 'changing invalid feed url' . $feed_url . ' to ' . 'http://' . $feed_url . "<br>\n";
        $feed_url = 'http://' . $feed_url;
      }
    }
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
      }
    }
} catch (\Exception $exception) {
  $msg = '(' . $exception->getCode() . ') Error processing "' . $feed_url . '" with message: ' . $exception->getMessage() . ' (file ' . $exception->getFile() . ', line ' . $exception->getLine() .')';

  $redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
    'service' => 'rss-fetch',
    'severity' => 'error',
    'feed_url' => $feed_url,
    'time' => time(),
    'msg' => $msg,
  ]));

  echo $msg ."\n";
  exit;
}

$time_end = microtime(true);
$log_msg = "fetch complete for $feed_url in " . (round($time_end - $time_start,3) * 1000) . 'ms';

$redis->publish( REDIS_LOGS_CHANNEL, json_encode( [
  'service' => 'rss-fetch',
  'severity' => 'log',
  'time' => time(),
  'msg' => $log_msg,
]));

echo "\n\n[" . date('j.m.Y, H:i:s') . "] $log_msg";