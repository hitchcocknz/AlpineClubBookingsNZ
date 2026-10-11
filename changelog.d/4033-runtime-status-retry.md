- **The deploy's checks on a newly started container now retry, and say why
  when they stop (#3965).** On 7 Oct 2026 a deploy stopped at step 15 with
  nothing printed, straight after the new container reported healthy; a check
  by hand moments later passed. The cause was not captured, which is what this
  fixes.

  At steps 14 and 15, and again just after the cutover at step 17, the deploy
  asks the new container whether it is ready and which release and role it is
  running. Each question is now asked again every 2 seconds for up to a minute
  (set `RUNTIME_STATUS_TIMEOUT_SECONDS` in the deploy shell to change that).
  Every failed attempt prints a line with the HTTP status, or, if Docker could
  not reach the container, its exit code and whether the container restarted
  or ran out of memory. When the deploy gives up it prints the last reply and
  whether traffic had already moved. A wrong cron secret or a missing route
  stops the deploy at once instead of waiting.
