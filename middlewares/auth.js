const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  }
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session && req.session.userId && req.session.userRole === 'admin') {
    return next();
  }
  res.status(403).send('Access denied');
};

const roleCheck = (roles) => {
  return (req, res, next) => {
    if (req.session && req.session.userId && roles.includes(req.session.userRole)) {
      return next();
    }
    res.status(403).send('Access denied');
  };
};

module.exports = {
  isAuthenticated,
  isAdmin,
  roleCheck
};
