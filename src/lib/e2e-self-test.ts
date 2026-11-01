import fs from 'fs';
import path from 'path';
import { runBankParserUnitTests } from './bank-parser.js';

async function runFullDiagnosticSuite() {
  console.log('================================================================');
  console.log(' OpenPay — By Aniket | Full Setup & End-to-End Diagnostic Suite ');
  console.log('================================================================\n');

  // 1. Verify Indian Bank SMS / Email Regex Parser Unit Tests
  console.log('1. Running Indian Bank & UPI Regex Parser Unit Tests...');
  const parserReport = runBankParserUnitTests();
  for (const res of parserReport.results) {
    if (!res.passed) {
      throw new Error(`Bank Parser Test Failed: ${res.institution} (${res.id})`);
    }
    console.log(
      `   [PASS] ${res.institution} [${res.channel}] -> ₹${((res.actualAmountPaise || 0) / 100).toFixed(2)} | UTR: ${res.actualUtr}`
    );
  }
  console.log(`   -> ${parserReport.passedCount}/${parserReport.total} Bank Regex Tests Passed.\n`);

  // 2. Verify Local Installation & Cross-Platform Package Compatibility
  console.log('2. Verifying Cross-Platform (Windows / macOS / Linux) Package Setup...');
  const rootDir = process.cwd();
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('package.json not found in current working directory.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  if (deps.esbuild) {
    throw new Error(
      `Conflicting top-level "esbuild" dependency (${deps.esbuild}) found in package.json.`
    );
  }
  if (!deps['react-is']) {
    throw new Error('Missing "react-is" dependency required by Recharts on React 19.');
  }
  if (String(deps.vite || '').startsWith('^8') || String(deps.vite || '').startsWith('8')) {
    throw new Error(
      `Vite 8 (${deps.vite}) detected — use Vite 6 (^6.2.0) to avoid Windows Rolldown/WASI native binding errors.`
    );
  }
  if (String(deps.recharts || '').startsWith('^3') || String(deps.recharts || '').startsWith('3')) {
    throw new Error(
      `Recharts 3 (${deps.recharts}) detected — use Recharts 2 (^2.15.1) to avoid @reduxjs/toolkit ESM resolution errors.`
    );
  }
  console.log(`   [PASS] vite: ${deps.vite}`);
  console.log(`   [PASS] @vitejs/plugin-react: ${deps['@vitejs/plugin-react']}`);
  console.log(`   [PASS] recharts: ${deps.recharts}`);
  console.log(`   [PASS] react-is: ${deps['react-is']}`);
  console.log('   [PASS] .npmrc present:', fs.existsSync(path.join(rootDir, '.npmrc')), '\n');

  // 3. Test Live Server & Vite Module Compilation (if server is running on port 3000)
  const baseUrl = process.env.OPENPAY_TEST_URL || 'http://localhost:3000';
  let serverReachable = false;
  try {
    const ping = await fetch(`${baseUrl}/api/admin/parser-tests`);
    serverReachable = ping.ok;
  } catch {
    serverReachable = false;
  }

  if (!serverReachable) {
    console.log(
      `3. Live Server Check: Server is not currently running on ${baseUrl} (start with "npm run dev" to run live HTTP/SSE tests).`
    );
    console.log('\nALL OFFLINE SETUP & PARSER DIAGNOSTICS PASSED!');
    return;
  }

  console.log(`3. Testing Live Server & Vite Frontend Module Compilation (${baseUrl})...`);
  const frontendModules = [
    '/',
    '/src/main.tsx',
    '/src/App.tsx',
    '/src/lib/types.ts',
    '/src/lib/bank-parser.ts',
    '/src/components/AdminDashboard.tsx',
    '/src/components/CustomerCheckoutModal.tsx',
    '/src/components/PaymentLinkView.tsx',
    '/src/components/AuthView.tsx',
    '/src/components/ProfileView.tsx',
    '/sdk.js',
  ];

  for (const modPath of frontendModules) {
    const res = await fetch(`${baseUrl}${modPath}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} when loading ${modPath}`);
    }
    const text = await res.text();
    if (text.includes('Pre-transform error') || text.includes('[plugin:vite:')) {
      throw new Error(`Vite transform error in ${modPath}:\n${text.slice(0, 400)}`);
    }
    console.log(`   [PASS] ${modPath} (${(text.length / 1024).toFixed(1)} KB)`);
  }

  // 4. Test Admin Snapshot, Live Order, Payment Link Priority, Bank Forwarder & Signature Verification
  console.log('\n4. Testing End-to-End Live Payment Lifecycle...');
  const snapRes = await fetch(`${baseUrl}/api/admin/snapshot`);
  if (!snapRes.ok) throw new Error(`Failed /api/admin/snapshot: ${snapRes.status}`);
  const snap = await snapRes.json();
  console.log(`   [PASS] Merchant Snapshot Loaded: ${snap.merchant.name} (${snap.merchant.vpa})`);

  // Create a unique test amount in paise so we don't collide with existing active sessions
  const randomPaise = (Math.floor(110 + Math.random() * 880) * 100) + 37;
  const orderRes = await fetch(`${baseUrl}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenPay-Key-Id': snap.merchant.api_key_id,
      'X-OpenPay-Key-Secret': snap.merchant.api_key_secret,
    },
    body: JSON.stringify({
      amount: randomPaise,
      currency: 'INR',
      receipt: `DIAG_${Date.now()}`,
      customer: {
        name: 'Diagnostic User',
        phone: '+91 98765 43210',
        email: 'diag@openpay.local',
      },
    }),
  });
  const orderData = await orderRes.json();
  if (!orderRes.ok) {
    throw new Error(`Order creation failed: ${JSON.stringify(orderData)}`);
  }
  console.log(
    `   [PASS] Live Payment Order Created: ${orderData.id} (Session: ${orderData.checkout_session_id})`
  );

  // Create Payment Link & Initiate Live Payment Session
  const linkRes = await fetch(`${baseUrl}/api/admin/payment-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Diagnostic Live Payment Link',
      description: 'Automated E2E verification link',
      amountPaise: 19900,
      customerName: 'Diagnostic Payer',
      customerPhone: '+91 98765 43210',
    }),
  });
  const linkData = await linkRes.json();
  if (!linkRes.ok || !linkData.paymentLink) {
    throw new Error(`Payment link creation failed: ${JSON.stringify(linkData)}`);
  }
  const shortCode = linkData.paymentLink.short_code;
  const initiateRes = await fetch(`${baseUrl}/api/payment-links/${shortCode}/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName: 'Diagnostic Payer', customerPhone: '+91 98765 43210' }),
  });
  const initiateData = await initiateRes.json();
  if (!initiateRes.ok || !initiateData.session) {
    throw new Error(`Payment link live session initiation failed: ${JSON.stringify(initiateData)}`);
  }
  console.log(
    `   [PASS] Hosted Payment Link (/pay/${shortCode}) Initiated Live Payment Session: ${initiateData.session.id}`
  );

  // Auto-Verify via Bank Forwarder Webhook
  const fakeUtr = String(Math.floor(100000000000 + Math.random() * 899999999999));
  const amountRupeesStr = (randomPaise / 100).toFixed(2);
  const fwdRes = await fetch(
    `${baseUrl}/api/webhooks/bank-forwarder/${snap.merchant.id}?secret=${snap.merchant.observer_secret}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawPayload: `Rs. ${amountRupeesStr} credited to a/c XX8921 on 29-10-26 by UPI Ref No ${fakeUtr} (Payer: customer@okaxis).`,
        sourceChannel: 'ANDROID_SMS',
      }),
    }
  );
  const fwdData = await fwdRes.json();
  if (!fwdRes.ok || fwdData.status !== 'MATCHED_AND_VERIFIED') {
    throw new Error(`Bank forwarder auto-verification failed: ${JSON.stringify(fwdData)}`);
  }
  console.log(`   [PASS] Bank Alert Auto-Forwarder Verified Order with 12-Digit UTR: ${fakeUtr}`);

  // Verify HMAC-SHA256 Payment Signature
  const verifyRes = await fetch(`${baseUrl}/api/v1/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: fwdData.matchedSession.order_id,
      sessionId: fwdData.matchedSession.id,
      signature: fwdData.matchedSession.payment_signature,
    }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok || !verifyData.verified) {
    throw new Error(`HMAC-SHA256 Signature verification failed: ${JSON.stringify(verifyData)}`);
  }
  console.log(
    `   [PASS] Cryptographic HMAC-SHA256 Signature Verified: ${verifyData.signature.slice(0, 20)}...`
  );

  console.log('\n================================================================');
  console.log(' ALL OPENPAY SETUP, FRONTEND, AND LIVE API DIAGNOSTICS PASSED! ');
  console.log('================================================================');
}

runFullDiagnosticSuite().catch((err) => {
  console.error('\n[DIAGNOSTIC FAILURE]:', err);
  process.exit(1);
});
