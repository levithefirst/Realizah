export const metadata = { title: "Terms · Realizah" };

export default function Terms() {
  return (
    <main className="prose">
      <h1>Terms</h1>
      <h2>Acceptable use</h2>
      <ul>
        <li>Use Realizah to compare AI tools for your own work.</li>
        <li>Do not submit personal data, secrets, or anything you are not allowed to share with a model provider.</li>
        <li>Do not try to get around the daily limit, overload the service, or use it to generate harmful content.</li>
      </ul>
      <h2>No warranty on the eval</h2>
      <p>
        A comparison is one short run on one fictional fixture with simple automatic checks. It is a signal, not a
        guarantee. Model output varies between runs, prices change, and a model that passes here may fail on your real
        work. The service is provided as is, without warranty of any kind.
      </p>
      <h2>Your spend</h2>
      <p>
        Free comparisons run on our key. If you later connect your own provider account, you are responsible for any
        spend on it. Cost figures are estimates from published per-token prices with an &ldquo;as of&rdquo; date, not invoices.
      </p>
      <h2>Changes</h2>
      <p>We may change these terms or the free limit. The current version is always on this page.</p>
    </main>
  );
}
