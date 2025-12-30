const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const typeDefs = require('./typeDefs');
const resolvers = require('./resolvers');

// Create Apollo Server instance
const createApolloServer = () => {
  return new ApolloServer({
    typeDefs,
    resolvers,
    formatError: (error) => {
      // Log error for debugging
      console.error('GraphQL Error:', error);

      // Return user-friendly error
      return {
        message: error.message,
        code: error.extensions?.code || 'INTERNAL_SERVER_ERROR',
        path: error.path
      };
    },
    introspection: process.env.NODE_ENV !== 'production'
  });
};

// Context function to extract user from JWT token
const createContext = async ({ req }) => {
  const context = { user: null };

  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from database
      const user = await User.findById(decoded.userId).select('-customStatuses -customNotifications');

      if (user) {
        context.user = {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          avatar: user.avatar,
          isPremium: user.isPremium
        };
      }
    }
  } catch (error) {
    // Token invalid or expired - user remains null
    console.error('GraphQL auth error:', error.message);
  }

  return context;
};

// Setup function to initialize Apollo Server with Express
const setupGraphQL = async (app) => {
  const server = createApolloServer();

  // Start the Apollo Server
  await server.start();

  // Apply middleware to Express app
  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: createContext
    })
  );

  console.log('GraphQL endpoint ready at /graphql');

  return server;
};

module.exports = { setupGraphQL, createApolloServer, createContext };
