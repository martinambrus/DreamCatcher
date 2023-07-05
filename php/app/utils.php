<?php
function fetch_url( $url, $timeout = 10 ) {
  $fp = curl_init();
  curl_setopt($fp, CURLOPT_RETURNTRANSFER, 1);
  curl_setopt($fp, CURLOPT_FAILONERROR, 1);
  curl_setopt($fp, CURLOPT_TIMEOUT, $timeout);
  curl_setopt($fp, CURLOPT_CONNECTTIMEOUT, $timeout);
  //curl_setopt($fp, CURLOPT_VERBOSE, 1);
  curl_setopt($fp, CURLOPT_HEADER, 1);
  curl_setopt($fp, CURLOPT_FOLLOWLOCATION, true);
  curl_setopt($fp, CURLOPT_MAXREDIRS, 10);
  curl_setopt($fp,  CURLOPT_CUSTOMREQUEST, 'GET');
  curl_setopt($fp, CURLOPT_ENCODING, '');
  curl_setopt($fp, CURLOPT_URL, $url);
  curl_setopt($fp, CURLOPT_REFERER, $url);
  curl_setopt($fp, CURLOPT_USERAGENT, 'DreamCatcher 0.1a');
  curl_setopt($fp, CURLOPT_SSL_VERIFYHOST, 0);
  curl_setopt($fp, CURLOPT_SSL_VERIFYPEER, false);

  $headers = array();
  $headers[] = 'Pragma: ';
  $headers[] = 'Accept-Language: en-us,en;q=0.5';
  $headers[] = 'Accept-Charset: ISO-8859-1,utf-8;q=0.7,*;q=0.7';
  $headers[] = 'Keep-Alive: 300';
  $headers[] = 'Connection: keep-alive';
  $headers[] = 'Accept: */*';
  $headers[] = 'Cache-Control: max-age=0';
  $headers[] = 'Expect:';
  curl_setopt($fp,  CURLOPT_HTTPHEADER, $headers);

  $result = curl_exec($fp);
  $curl_info = curl_getinfo($fp);
  if (curl_errno($fp) === 23 || curl_errno($fp) === 61) {
    curl_setopt($fp, CURLOPT_ENCODING, 'none');
    $result = curl_exec($fp);
  }

  if (curl_errno($fp)) {
    return [ curl_error($fp) ];
  } else {
    curl_close($fp);

    // return header-less response
    $header_size = $curl_info["header_size"];
    // $header = substr($result, 0, $header_size);
    $body = substr($result, $header_size);

    return clean_feed( $body );
  }
}

function clean_feed( $body ) {
  // remove content tags, as they usually cause invalid unparsable XML
  $body = preg_replace('/(?s)<[\s\/]*content[^>]*>.*?<\/content[^>]*>/mi', '', $body);

  return $body;
}

function get_feed( $url, $raw_data = false ) {
  // if we have clear data passed, try to clean it up
  if ($raw_data !== false) {
    $raw_data = clean_feed( $raw_data );
  }

  // try a discovery of feeds using SimplePie
  $feed = new SimplePie();
  $feed->set_useragent('DreamCatcher 0.1a'); // resolves FeedBurner's issues
  $feed->set_curl_options([
    CURLOPT_SSL_VERIFYHOST => 0,
    CURLOPT_SSL_VERIFYPEER => false,
  ]);
  $feed->enable_cache( false );
  $feed->enable_order_by_date( true );

  if ($raw_data === false) {
    $feed->set_feed_url( $url );
  } else {
    $feed->set_raw_data( $raw_data );
  }

  //$success = $feed->init();
  $feed->init();
  $feed->handle_content_type();

  return $feed;
}

function untagize( $txt ) {
  // decode all HTML entities, so &gt; becomes > and we can remove tags in the next step
  $txt = html_entity_decode( $txt, ENT_QUOTES || ENT_HTML5, "UTF-8" );

  // remove all HTML tags
  $txt = strip_tags( $txt );

  //  convert all special unicode entities (&#39;) into their ASCII representation (')
  $txt = entities_to_unicode( $txt );

  return $txt;
}

function entities_to_unicode($str) {
  $str = html_entity_decode($str, ENT_QUOTES, 'UTF-8');
  $str = preg_replace_callback("/(&#[0-9]+;)/", function($m) { return mb_convert_encoding($m[1], "UTF-8", "HTML-ENTITIES"); }, $str);
  return $str;
}