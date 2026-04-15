function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'יש להתחבר כדי לבצע פעולה זו' });
  }
  next();
}

module.exports = { requireAuth };
