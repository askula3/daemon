# Security policy

## Supported versions

Security fixes are applied to the latest released version of SpringBreaker.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory flow for `askula3/daemon` and include the affected version,
reproduction steps, impact, and any proposed mitigation. Maintainers should
acknowledge a report within seven days and coordinate disclosure after a fix is
available.

## Trust boundary

Target Maven repositories are untrusted input. Maven wrappers, build plugins,
and tests execute project-controlled code. Run SpringBreaker with a dedicated,
least-privilege OS account or container, restrict `SPRINGBREAKER_ALLOWED_ROOTS`,
and grant IQ/Nexus credentials only the permissions required for scanning and
artifact search. HTTPS is required for non-loopback services by default.
