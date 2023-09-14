SELECT
  feeds.url
FROM
  feeds
WHERE
  (
    (feeds.subscribers <> '{}' :: jsonb)
    AND (feeds.active = 1)
    AND (
      (
        (feeds.next_fetch_ts = 0)
        OR (
          (feeds.next_fetch_ts) :: numeric <= round(
            EXTRACT(
              epoch
              FROM
                NOW()
            )
          )
        )
      )
      AND (feeds.subsequent_errors_counter < 10)
    )
  );