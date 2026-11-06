# ValidationCheck status

Public, independent status monitor for https://validationcheck.net.

Hourly GitHub Actions checks exercise the production website, dashboard, API, and deterministic test-mode lookup routes. These checks do not measure external provider accuracy or live billing. The application source is maintained separately in a private repository.

The workflow requires a restricted test-mode `VC_TEST_KEY` repository secret and publishes generated status artifacts to the `gh-pages` branch. The intended custom domain is https://status.validationcheck.net.
