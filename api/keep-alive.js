const SUPABASE_URL = "https://dlubzvvogzbhlninzhyz.supabase.co";

export default async function handler(req, res) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/health`);
    const ok = response.ok;
    res.status(200).json({
      ok,
      checkedAt: new Date().toISOString(),
      message: ok ? "Supabase respondió OK, actividad registrada." : "Supabase no respondió como se esperaba.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
