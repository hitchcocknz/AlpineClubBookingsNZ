- **A deploy no longer stops without a word when a new container is slow to
  report its status (#3965).** Just before the cutover, the deploy asks each
  newly started container which release and role it is running. If the
  container had passed its health check but was not quite ready to answer, the
  deploy could stop at step 15 with nothing printed, and had to be re-run
  by hand.

  The deploy now asks again every 2 seconds for up to a minute (set
  `RUNTIME_STATUS_TIMEOUT_SECONDS` to change that). If the container still has
  not answered, the deploy prints the last reply it got, with its status code,
  and stops before any traffic moves, so the previous release keeps serving.
