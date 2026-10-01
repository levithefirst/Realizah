export const metadata = { title: "Privacy · Realizah" };

export default function Privacy() {
  return (
    <main className="prose">
      <h1>Privacy</h1>
      <p>Realizah keeps the minimum it needs to run a comparison and show you the result.</p>
      <h2>What we store</h2>
      <ul>
        <li>The tool name you enter, what you use it for, and the task text you type.</li>
        <li>The models Realizah selected and your success checks (word cap, banned phrases).</li>
        <li>Per call: token counts, estimated cost, latency, pass or fail.</li>
        <li>A one-way SHA-256 hash of your IP address, used only to enforce the free daily limit. We never store the raw IP.</li>
      </ul>
      <h2>What we do not store</h2>
      <ul>
        <li>No accounts, emails, cookies for tracking, or analytics profiles.</li>
        <li>No files or uploads. Only the task text you type is sent to the models. Leave it empty and a fictional sample ticket is used instead.</li>
        <li>Model answers are shown to you and not saved to our database.</li>
      </ul>
      <h2>Retention</h2>
      <p>Runs, results and audit events are deleted after 14 days. Rate-limit counters are deleted after 2 days.</p>
      <h2>Sharing</h2>
      <p>
        We do not sell or rent data. Your task text (or, for a demo run, the fictional sample ticket) is sent to the model providers Realizah
        selects (OpenRouter, OpenAI) to run the comparison, under each provider&apos;s API data policy. Comparisons may include free-tier endpoints as screening runs;
        some free-tier providers log prompts, so don&apos;t put anything private in a task. Provider keys and database credentials stay on the server and are never sent to your browser.
      </p>
      <h2>Contact</h2>
      <p>Questions or deletion requests: open an issue on the project&apos;s GitHub repository.</p>
    </main>
  );
}
