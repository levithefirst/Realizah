// Demo fixture only. Used when the user submits no task of their own; a task
// the user typed is always sent as written and never replaced by this.
// A short, entirely fictional support ticket with an invoice attached.
// Kept near 150 words so every comparison costs fractions of a cent.
// No real customer data is ever sent to a model.
export const FIXTURE = `Support ticket #48213, opened 3 March by Dana Okafor, operations lead at Brightwell Bakery Co.

Subject: Charged twice for February

Hi team, our February invoice (INV-2291) shows two charges for the Growth plan: $149.00 on 1 February and again $149.00 on 3 February. We only have one workspace and eight seats. Our card ending 4417 was billed both times. The second charge pushed our account into overdraft and the bank added a $35.00 fee.

We also upgraded from Starter to Growth on 28 January, so I am not sure if the first charge was a prorated amount that went wrong. The invoice lists no proration line.

Please refund the duplicate charge and confirm whether you can cover the bank fee. We need this resolved before our books close on 10 March. I can share the bank statement if needed.

Thanks,
Dana`;

export const DEFAULT_TASK =
  "Summarize this support ticket in 80 words or fewer. Do not invent any facts.";
