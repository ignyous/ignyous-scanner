/**
 * ignyous Site Scanner Service
 * ─────────────────────────────────────────────────────────────────
 * Crawls a public URL to detect WordPress, builder, theme, plugins,
 * content structure, and performance indicators — no login required
 * for the initial scan.
 *
 * POST /scan       { url }  → full site report
 * POST /scan/quick { url }  → just CMS + builder detection (fast)
 * GET  /health              → service health check
 *
 * Usage:
 *   npm install
 *   node scanner.js
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const https     = require('https');
const http      = require('http');
const { URL }   = require('url');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ═══════════════════════════════════════════════
// HTTP CLIENT — follows redirects, spoofs browser
// ═══════════════════════════════════════════════
const httpClient = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'ignyous-Scanner/1.0 (site analysis; +https://ignyous.ai)',
    'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }), // handle self-signed certs on dev sites
});

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

// Full deep scan
app.post('/scan', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const report = await fullScan(normalizeUrl(url));
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick CMS/builder detect only
app.post('/scan/quick', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const normalized = normalizeUrl(url);
    const { html, headers, finalUrl, statusCode, loadTime } = await fetchPage(normalized);
    const $ = cheerio.load(html);
    res.json({
      success: true,
      url: finalUrl,
      status_code: statusCode,
      load_time_ms: loadTime,
      ...detectCMS($, headers, html),
      builder: detectBuilder($, html),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ═══════════════════════════════════════════════
// FULL SCAN ORCHESTRATOR
// ═══════════════════════════════════════════════
async function fullScan(url) {
  const started = Date.now();

  // Phase 1 — fetch homepage
  const { html, headers, finalUrl, statusCode, loadTime } = await fetchPage(url);
  const $ = cheerio.load(html);

  // Phase 2 — parallel checks
  const [
    cmsInfo,
    builderInfo,
    seoInfo,
    performanceInfo,
    wpRestData,
    formsInfo,
    analyticsInfo,
    securityInfo,
  ] = await Promise.allSettled([
    Promise.resolve(detectCMS($, headers, html)),
    Promise.resolve(detectBuilder($, html)),
    Promise.resolve(extractSEO($, finalUrl)),
    Promise.resolve(measurePerformance(html, headers, loadTime)),
    fetchWpRestApi(finalUrl),
    Promise.resolve(detectForms($)),
    Promise.resolve(detectAnalytics($, html)),
    Promise.resolve(checkSecurity(headers, finalUrl)),
  ]);

  const get = (settled) => settled.status === 'fulfilled' ? settled.value : null;
  const wpData = get(wpRestData);

  // Phase 3 — aggregate and score
  const report = {
    url:             finalUrl,
    original_url:    url,
    status_code:     statusCode,
    scan_duration_ms:Date.now() - started,
    load_time_ms:    loadTime,

    cms:          get(cmsInfo),
    builder:      get(builderInfo),
    seo:          get(seoInfo),
    performance:  get(performanceInfo),
    security:     get(securityInfo),
    forms:        get(formsInfo),
    analytics:    get(analyticsInfo),

    // WordPress-specific (from REST API)
    wordpress: wpData ? {
      version:      wpData.description || null,
      pages:        wpData.pages || [],
      posts:        wpData.posts || [],
      categories:   wpData.categories || [],
      plugins_hint: wpData.plugins_hint || [],
      theme:        wpData.theme || null,
    } : null,

    // AI recommendations based on all data
    recommendations: buildRecommendations({
      cms:        get(cmsInfo),
      builder:    get(builderInfo),
      seo:        get(seoInfo),
      perf:       get(performanceInfo),
      security:   get(securityInfo),
      forms:      get(formsInfo),
      analytics:  get(analyticsInfo),
    }),

    scores: {
      overall: 0,  // computed below
      seo: 0,
      performance: 0,
      security: 0,
      mobile: 0,
    },
  };

  // Final scores
  report.scores = computeScores(report);

  return report;
}

// ═══════════════════════════════════════════════
// FETCHER
// ═══════════════════════════════════════════════
async function fetchPage(url) {
  const t0 = Date.now()
  const response = await httpClient.get(url, {
    validateStatus: (status) => status < 500, // accept anything under 500
  })
  return {
    html:       typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
    headers:    response.headers,
    finalUrl:   response.request?.res?.responseUrl || url,
    statusCode: response.status,
    loadTime:   Date.now() - t0,
  }
}

function normalizeUrl(url) {
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// ═══════════════════════════════════════════════
// CMS DETECTION
// ═══════════════════════════════════════════════
function detectCMS($, headers, html) {
  const checks = {
    is_wordpress: false,
    wp_version:   null,
    confidence:   0,
    signals:      [],
  };

  // 1. Generator meta tag
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (generator.toLowerCase().includes('wordpress')) {
    checks.is_wordpress = true;
    checks.confidence += 40;
    checks.signals.push('generator meta tag');
    const match = generator.match(/WordPress\s+([\d.]+)/i);
    if (match) checks.wp_version = match[1];
  }

  // 2. wp-content in HTML
  if (html.includes('/wp-content/')) {
    checks.is_wordpress = true;
    checks.confidence = Math.min(checks.confidence + 30, 100);
    checks.signals.push('wp-content path');
  }

  // 3. wp-json in Link header
  const linkHeader = headers['link'] || '';
  if (linkHeader.includes('wp-json') || linkHeader.includes('wp/v2')) {
    checks.is_wordpress = true;
    checks.confidence = Math.min(checks.confidence + 20, 100);
    checks.signals.push('REST API link header');
  }

  // 4. WP-specific cookies or headers
  if (headers['x-powered-by']?.includes('WordPress') ||
      headers['x-wp-total'] !== undefined) {
    checks.is_wordpress = true;
    checks.confidence = Math.min(checks.confidence + 10, 100);
    checks.signals.push('WordPress response headers');
  }

  // 5. Inline wp-settings script
  if (html.includes('wp-settings') || html.includes('var wpApiSettings')) {
    checks.is_wordpress = true;
    checks.confidence = Math.min(checks.confidence + 10, 100);
    checks.signals.push('wp-settings script');
  }

  return checks;
}

// ═══════════════════════════════════════════════
// BUILDER DETECTION
// ═══════════════════════════════════════════════
function detectBuilder($, html) {
  const builders = [];

  const SIGS = {
    elementor: {
      name: 'Elementor',
      patterns: [
        () => html.includes('elementor-'),
        () => html.includes('/wp-content/plugins/elementor/'),
        () => html.includes('data-elementor-'),
        () => $('[data-elementor-type]').length > 0,
      ],
    },
    'elementor-pro': {
      name: 'Elementor Pro',
      patterns: [
        () => html.includes('/wp-content/plugins/elementor-pro/'),
        () => html.includes('elementorProConfig'),
      ],
    },
    avada: {
      name: 'Avada / Fusion Builder',
      patterns: [
        () => html.includes('fusion-builder'),
        () => html.includes('/avada/'),
        () => html.includes('FusionPageBuilder'),
        () => $('[data-fusion-]').length > 0,
        () => html.includes('fusion_builder_container'),
      ],
    },
    divi: {
      name: 'Divi Builder',
      patterns: [
        () => html.includes('et_pb_'),
        () => html.includes('/divi/'),
        () => html.includes('DiviBuilderApp'),
        () => $('[class*="et_pb_"]').length > 0,
      ],
    },
    gutenberg: {
      name: 'Gutenberg (Block Editor)',
      patterns: [
        () => html.includes('wp-block-'),
        () => $('[class*="wp-block-"]').length > 0,
        () => html.includes('<!-- wp:'),
      ],
    },
    'beaver-builder': {
      name: 'Beaver Builder',
      patterns: [
        () => html.includes('fl-builder'),
        () => html.includes('fl-row'),
        () => html.includes('/beaver-builder/'),
      ],
    },
    oxygen: {
      name: 'Oxygen Builder',
      patterns: [
        () => html.includes('oxygen-vsb'),
        () => html.includes('/oxygen/'),
        () => html.includes('ct-container'),
      ],
    },
    wpbakery: {
      name: 'WPBakery Page Builder',
      patterns: [
        () => html.includes('vc_row'),
        () => html.includes('wpb_wrapper'),
        () => html.includes('/js_composer/'),
      ],
    },
    bricks: {
      name: 'Bricks Builder',
      patterns: [
        () => html.includes('brxe-'),
        () => html.includes('/bricks/'),
      ],
    },
  };

  for (const [id, info] of Object.entries(SIGS)) {
    const hits = info.patterns.filter(fn => { try { return fn(); } catch { return false; } }).length;
    if (hits > 0) {
      builders.push({ id, name: info.name, confidence: Math.min(hits * 25, 100) });
    }
  }

  // Sort by confidence
  return builders.sort((a, b) => b.confidence - a.confidence);
}

// ═══════════════════════════════════════════════
// SEO EXTRACTION
// ═══════════════════════════════════════════════
function extractSEO($, url) {
  return {
    title:            $('title').text().trim(),
    title_length:     $('title').text().trim().length,
    meta_description: $('meta[name="description"]').attr('content') || null,
    meta_desc_length: ($('meta[name="description"]').attr('content') || '').length,
    og_title:         $('meta[property="og:title"]').attr('content') || null,
    og_description:   $('meta[property="og:description"]').attr('content') || null,
    og_image:         $('meta[property="og:image"]').attr('content') || null,
    canonical:        $('link[rel="canonical"]').attr('href') || null,
    has_h1:           $('h1').length > 0,
    h1_count:         $('h1').length,
    h1_text:          $('h1').first().text().trim(),
    has_schema:       html_includes_schema($),
    images_without_alt: $('img:not([alt])').length,
    internal_links:   $('a[href]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return href.startsWith('/') || href.includes(new URL(url).hostname);
    }).length,
    robots:           $('meta[name="robots"]').attr('content') || 'index,follow',
    yoast_detected:   $('meta[name="generator"]').attr('content')?.includes('Yoast') || false,
    rank_math_detected: $('meta[name="generator"]').attr('content')?.includes('Rank Math') || false,
  };
}

function html_includes_schema($) {
  return $('script[type="application/ld+json"]').length > 0;
}

// ═══════════════════════════════════════════════
// PERFORMANCE ANALYSIS (from HTML, no Lighthouse)
// ═══════════════════════════════════════════════
function measurePerformance(html, headers, loadTime) {
  const $ = cheerio.load(html);
  const scripts    = $('script[src]').length;
  const styles     = $('link[rel="stylesheet"]').length;
  const images     = $('img').length;
  const lazyImages = $('img[loading="lazy"]').length;
  const htmlSizeKB = Math.round(Buffer.byteLength(html, 'utf8') / 1024);

  // Infer CDN from headers
  const cdnHeaders = ['cf-ray','x-served-by','x-cache','x-amz-cf-id','x-fastly-request-id'];
  const cdn = cdnHeaders.some(h => headers[h]) ? 'Detected' : 'Not detected';
  const compression = headers['content-encoding'] || 'none';
  const cacheControl = headers['cache-control'] || 'none';
  const https = true; // we already normalized to https

  // Rough performance score
  let score = 100;
  if (loadTime > 3000) score -= 30;
  else if (loadTime > 1500) score -= 15;
  if (scripts > 20) score -= 10;
  if (styles > 10) score -= 5;
  if (htmlSizeKB > 200) score -= 10;
  if (cdn === 'Not detected') score -= 10;
  if (compression === 'none') score -= 10;
  if (images > 0 && lazyImages === 0) score -= 5;

  return {
    load_time_ms:      loadTime,
    html_size_kb:      htmlSizeKB,
    scripts_count:     scripts,
    stylesheets_count: styles,
    images_count:      images,
    lazy_images_count: lazyImages,
    cdn:               cdn,
    compression:       compression,
    cache_control:     cacheControl,
    https:             https,
    estimated_score:   Math.max(0, score),
    mobile_viewport:   $('meta[name="viewport"]').length > 0,
  };
}

// ═══════════════════════════════════════════════
// WORDPRESS REST API — optional deep data
// ═══════════════════════════════════════════════
async function fetchWpRestApi(url) {
  try {
    const base = new URL(url).origin;

    // Fetch pages and posts concurrently
    const [pagesRes, postsRes, catsRes] = await Promise.allSettled([
      httpClient.get(`${base}/wp-json/wp/v2/pages?per_page=50&_fields=id,title,slug,status,link,modified`),
      httpClient.get(`${base}/wp-json/wp/v2/posts?per_page=10&_fields=id,title,slug,status,link,modified`),
      httpClient.get(`${base}/wp-json/wp/v2/categories?per_page=20&_fields=id,name,slug,count`),
    ]);

    const pages = pagesRes.status === 'fulfilled' ? pagesRes.value.data : [];
    const posts = postsRes.status === 'fulfilled' ? postsRes.value.data : [];
    const cats  = catsRes.status === 'fulfilled'  ? catsRes.value.data  : [];

    // Probe for common plugin REST namespaces to infer installed plugins
    const pluginProbes = [
      { ns: 'wc/v3',       name: 'WooCommerce' },
      { ns: 'yoast/v1',    name: 'Yoast SEO' },
      { ns: 'elementor/v1',name: 'Elementor' },
      { ns: 'wpforms/v1',  name: 'WPForms' },
      { ns: 'cf7/v1',      name: 'Contact Form 7' },
      { ns: 'rml/v1',      name: 'Real Media Library' },
    ];
    const pluginsHint = [];
    const nsRes = await httpClient.get(`${base}/wp-json/`).catch(() => null);
    if (nsRes?.data?.namespaces) {
      for (const probe of pluginProbes) {
        if (nsRes.data.namespaces.includes(probe.ns)) {
          pluginsHint.push(probe.name);
        }
      }
    }

    return { pages, posts, categories: cats, plugins_hint: pluginsHint };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════
// FORMS
// ═══════════════════════════════════════════════
function detectForms($) {
  const forms = [];
  $('form').each((_, el) => {
    const $form = $(el);
    const action = $form.attr('action') || '';
    const id     = $form.attr('id') || $form.attr('class') || '';
    let plugin   = 'Unknown / custom';

    if (id.includes('wpcf7') || $form.find('.wpcf7').length) plugin = 'Contact Form 7';
    else if (id.includes('wpforms') || $form.hasClass('wpforms-form')) plugin = 'WPForms';
    else if ($form.hasClass('gform_wrapper') || id.includes('gform')) plugin = 'Gravity Forms';
    else if ($form.hasClass('elementor-form')) plugin = 'Elementor Form';

    forms.push({
      id:      id.substring(0, 50),
      action:  action.substring(0, 100),
      method:  $form.attr('method') || 'get',
      plugin,
      fields:  $form.find('input:not([type=hidden]),textarea,select').length,
      has_email_field: $form.find('input[type=email]').length > 0,
    });
  });
  return { count: forms.length, forms: forms.slice(0, 10) };
}

// ═══════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════
function detectAnalytics($, html) {
  return {
    google_analytics: html.includes('google-analytics.com') || html.includes('gtag(') || html.includes('UA-') || html.includes('G-'),
    google_tag_manager: html.includes('googletagmanager.com') || html.includes('GTM-'),
    facebook_pixel: html.includes('fbq(') || html.includes('connect.facebook.net'),
    hotjar: html.includes('hotjar.com') || html.includes('hj('),
    hubspot: html.includes('hs-scripts.com') || html.includes('_hsq'),
    crisp_chat: html.includes('crisp.chat'),
    intercom: html.includes('intercom.io'),
    tawk_to: html.includes('tawk.to'),
  };
}

// ═══════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════
function checkSecurity(headers, url) {
  return {
    https:                   url.startsWith('https://'),
    hsts:                    !!headers['strict-transport-security'],
    x_frame_options:         headers['x-frame-options'] || null,
    x_content_type_options:  headers['x-content-type-options'] || null,
    x_xss_protection:        headers['x-xss-protection'] || null,
    content_security_policy: !!headers['content-security-policy'],
    server_exposed:          headers['server'] || null,
    wp_version_exposed:      !!headers['x-powered-by']?.includes('WordPress'),
  };
}

// ═══════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════
function computeScores(report) {
  // SEO score
  let seo = 100;
  const s = report.seo || {};
  if (!s.meta_description || s.meta_desc_length < 50)  seo -= 15;
  if (!s.has_h1)                                        seo -= 20;
  if (s.images_without_alt > 3)                         seo -= 10;
  if (!s.has_schema)                                    seo -= 10;
  if (s.title_length < 30 || s.title_length > 70)       seo -= 10;
  seo = Math.max(0, seo);

  // Performance score
  const perf = Math.max(0, report.performance?.estimated_score || 50);

  // Security score
  let sec = 100;
  const sec_r = report.security || {};
  if (!sec_r.https)                  sec -= 40;
  if (!sec_r.hsts)                   sec -= 15;
  if (!sec_r.x_frame_options)        sec -= 10;
  if (!sec_r.content_security_policy)sec -= 15;
  if (sec_r.server_exposed)          sec -= 10;
  sec = Math.max(0, sec);

  // Mobile score
  const perf_r = report.performance || {};
  let mobile = 100;
  if (!perf_r.mobile_viewport) mobile -= 40;
  if (perf_r.load_time_ms > 3000) mobile -= 20;
  if (perf_r.cdn === 'Not detected') mobile -= 10;
  mobile = Math.max(0, mobile);

  const overall = Math.round((seo * 0.3 + perf * 0.35 + sec * 0.15 + mobile * 0.2));
  return { overall, seo, performance: perf, security: sec, mobile };
}

// ═══════════════════════════════════════════════
// AI RECOMMENDATIONS
// ═══════════════════════════════════════════════
function buildRecommendations({ cms, builder, seo, perf, security, forms, analytics }) {
  const recs = [];

  // CMS version warnings
  if (cms?.wp_version) {
    const v = parseFloat(cms.wp_version);
    if (v < 6.0) recs.push({
      severity: 'high',
      category: 'Security',
      title: `WordPress ${cms.wp_version} is significantly out of date`,
      detail: 'Running old WordPress exposes you to security vulnerabilities. ignyous will update to 6.7 during setup.',
      fix: 'update_wordpress',
    });
  }

  // Builder-specific
  if (!builder?.length || !builder.find(b => b.id !== 'gutenberg')) {
    recs.push({
      severity: 'medium',
      category: 'Design',
      title: 'No modern page builder detected',
      detail: 'ignyous works best with Elementor, Avada, or Gutenberg blocks. We can install and migrate your content.',
      fix: 'install_elementor',
    });
  }

  // SEO
  if (!seo?.meta_description) recs.push({
    severity: 'high', category: 'SEO',
    title: 'Missing meta description',
    detail: 'Search engines show this snippet in results. Missing it hurts click-through rates.',
    fix: 'add_meta_description',
  });
  if (!seo?.has_h1) recs.push({
    severity: 'high', category: 'SEO',
    title: 'No H1 heading found on homepage',
    detail: 'An H1 tells search engines what your page is about. This is a critical on-page SEO factor.',
    fix: 'add_h1',
  });
  if (seo?.images_without_alt > 0) recs.push({
    severity: 'medium', category: 'SEO & Accessibility',
    title: `${seo.images_without_alt} image(s) missing alt text`,
    detail: 'Alt text helps search engines understand images and is required for accessibility compliance.',
    fix: 'fix_alt_text',
  });

  // Performance
  if (perf?.load_time_ms > 3000) recs.push({
    severity: 'high', category: 'Performance',
    title: `Slow load time — ${(perf.load_time_ms / 1000).toFixed(1)}s`,
    detail: 'Sites loading over 3s lose 40% of visitors. ignyous will enable CDN, caching, and image optimization.',
    fix: 'improve_performance',
  });
  if (perf?.cdn === 'Not detected') recs.push({
    severity: 'medium', category: 'Performance',
    title: 'No CDN detected',
    detail: 'A Content Delivery Network dramatically speeds up your site globally. WP Engine includes one.',
    fix: 'enable_cdn',
  });
  if (perf?.mobile_viewport === false) recs.push({
    severity: 'high', category: 'Mobile',
    title: 'Site is not mobile-optimized',
    detail: '60%+ of searches are on mobile. Missing viewport meta tag means this site breaks on phones.',
    fix: 'fix_mobile',
  });

  // Security
  if (!security?.https) recs.push({
    severity: 'high', category: 'Security',
    title: 'Site is not served over HTTPS',
    detail: 'Google penalizes non-HTTPS sites. Browsers show "Not Secure" warnings to visitors.',
    fix: 'enable_https',
  });

  // Forms / leads
  if (!forms?.count) recs.push({
    severity: 'medium', category: 'Leads',
    title: 'No contact form found',
    detail: 'A contact form with instant SMS alerts is the #1 way to capture leads. ignyous can add one.',
    fix: 'add_contact_form',
  });
  if (forms?.count && !analytics?.google_analytics) recs.push({
    severity: 'low', category: 'Analytics',
    title: 'No analytics tracking installed',
    detail: 'Without Google Analytics or Tag Manager, you can\'t see where visitors come from.',
    fix: 'add_analytics',
  });

  return recs.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });
}

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`[ignyous Scanner] Running on port ${PORT}`);
});

module.exports = app; // for testing
