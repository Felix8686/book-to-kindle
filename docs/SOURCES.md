# Book resolution and sources

Book to Kindle v0.6 separates **book identity resolution** from **download sources**.

This is intentional: an English title, a Chinese translated title, an ISBN and a Kindle product listing may all refer to the same underlying work, while the downloadable file can come from a completely different provider.

## Language preference

Telegram users have a persistent default language preference.

System default:

```text
Chinese preferred (zh)
EPUB preferred
```

Preference order:

```text
explicit language in this request
> saved Telegram user setting
> system default zh
```

`zh` is a **preference, not a hard filter**. If no matching Chinese downloadable edition is found, the workflow can fall back to another language instead of immediately ending at `needs_source`.

Commands:

```text
/settings
/language zh
/language en
/语言 中文
/语言 英文
```

A one-off message such as `Thinking, Fast and Slow 英文` overrides the saved preference for that task only.

## Work resolver layer

Before download-source search, the queue worker builds a lightweight canonical identity.

Enabled resolvers:

### Open Library

Used for:

- work identity;
- authors;
- ISBNs;
- work/edition relationships;
- language-specific edition titles.

The resolver uses Open Library's `lang` preference and, for the best matching work, inspects edition metadata so that a request entered with an English title can discover a known Chinese edition title without blindly machine-translating the title.

### Google Books

Used as a second independent metadata source for:

- title and author confirmation;
- language;
- ISBNs;
- additional edition titles;
- Google volume identifiers.

Resolver failures are isolated with `Promise.allSettled`; one unavailable metadata service does not stop the book workflow.

### Amazon catalog

Not enabled in the default deployment.

Amazon can be useful as an optional future catalog resolver for commercial edition names, ASINs, language and publication metadata. It is deliberately not scraped. If it is added later, it should use Amazon's supported API with user-provided credentials and remain optional so the workflow still works with Open Library + Google Books alone.

## Download SourceAdapters

Enabled in v0.6:

### `zlibrary`

Search metadata and files: ZLibrary, via the official JSON `/eapi/` interface (the HTML site is protected by browser challenges, but the JSON endpoints are usable from server-side clients).

Requires an account. Configure either:

```text
ZLIBRARY_EMAIL + ZLIBRARY_PASSWORD
```

or the longer-lived session values (preferred for unattended workers):

```text
ZLIBRARY_REMIX_USERID + ZLIBRARY_REMIX_USERKEY
```

Optional:

```text
ZLIBRARY_DOMAIN   # override the default eapi base domain (default: https://1lib.fr, https://singlelogin.me)
```

The adapter logs in (or reuses the remix session), searches with the resolved title variants plus the requested author, keeps only EPUB/PDF results, and marks candidates with a high source quality. Downloads resolve the per-book file endpoint and are restricted to the account's personal download domains; credentials are never written into code, logs or Git.

### `gutendex`

Search metadata: Gutendex.

Files: Project Gutenberg.

Only public-domain Gutendex records (`copyright=false`) are accepted. Download redirects stay inside the Gutenberg host allowlist.

### `google-books-free`

Searches Google Books with `filter=free-ebooks` and only emits candidates that have full-volume/public access plus an actual EPUB or PDF download link.

Preview-only and paid items are not treated as downloadable candidates.

Download URLs and redirects are restricted to Google-owned book/content hosts.

### `internet-archive-public`

Uses Open Library availability metadata to identify records marked `ebook_access=public`, then reads the corresponding Internet Archive item metadata.

Restricted/private files are rejected. Only public EPUB/PDF files are emitted as candidates.

## Sources investigated but not enabled by default

### Standard Ebooks

Standard Ebooks remains a desirable high-quality public-domain EPUB source, but its searchable OPDS catalog currently requires Patrons Circle/open-source-project access rather than being an anonymous public API. The project therefore does not depend on it by default. It can be added later if project access is granted.

### OAPEN

OAPEN is a strong candidate for open-access academic books. It is not enabled in this release because the cloud adapter should rely on a stable, verified machine API rather than scraping the library UI. Add it once the production API contract used by the project is validated.

## Multi-source ranking

Source order does not decide the winner.

All results are normalized to the same `BookCandidate` type and ranked with signals including:

1. ISBN overlap with the resolved work;
2. title/edition match;
3. author match;
4. preferred language;
5. requested/default format;
6. source quality;
7. cloud file-size constraints.

Language preference has enough weight to prefer a matching Chinese edition over a higher-quality English source when the user's effective language is `zh`.

## Deduplication

Candidates are deduplicated across providers using ISBN when available. When no shared ISBN exists, the fallback key retains each provider's edition key; this favors showing an extra choice over incorrectly merging distinct editions.

This prevents the same edition returned by multiple providers from creating a long list of nearly identical Telegram buttons.

## Failure isolation

Resolver and download-source searches run independently. A single source failure is logged and ignored while remaining sources continue.

Only when all enabled download sources fail to produce a compatible candidate does the task end in `needs_source`.

## Future adapters

The core remains adapter-based:

```text
SourceAdapter
├── GutendexSource
├── GoogleBooksFreeSource
├── InternetArchivePublicSource
└── future adapters
```

New sources should not require changes to the Gmail/Kindle delivery path or make Hermes a mandatory runtime component.
