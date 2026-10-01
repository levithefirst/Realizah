export const metadata = { title: "Privacy · Realizah" };

export default function Privacy() {
  return (
    <main className="prose">
      <h1>Privacy</h1>
      <p>Realizah keeps the minimum it needs to run a comparison and show you the result.</p>
      <h2>What we store</h2>
      <ul>
        <li>The tool name you enter, what you use it for, and the task text you type.</li>
        <li>The model ids you picked and your success checks (word cap, banned phrases).</li>
        <li>Per call: token counts, estimated cost, latency, pass or fail.</li>
        <li>A one-way SHA-256 hash of your IP address, used only to enforce the free daily limit. We never store the raw IP.</li>
      </ul>
      <h2>What we do not store</h2>
      <ul>
        <li>No accounts, emails, cookies for tracking, or analytics profiles.</li>
        <li>No files. Every comparison runs on a short fictional fixture, not your documents.</li>
        <li>Model answers are shown to you and not saved to our database.</li>
      </ul>
      <h2>Retention</h2>
      <p>Runs, results and audit events are deleted after 14 days. Rate-limit counters are deleted after 2 days.</p>
      <h2>Sharing</h2>
      <p>
        We do not sell or rent data. Your task text and the fixture are sent to OpenAI to run the comparison,
        under OpenAI&apos;s API data policy. Our OpenAI key and database credentials stay on the server and are never sent to your browser.
      </p>
      <h2>Contact</h2>
      <p>Questions or deletion requests: open an issue on the project&apos;s GitHub repository.</p>
    </main>
  );
}
