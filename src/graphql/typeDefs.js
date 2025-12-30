const typeDefs = `#graphql
  # User types
  type User {
    id: ID!
    name: String!
    avatar: String
    phone: String
    email: String
    status: Status
    lastActive: String
    isPremium: Boolean
  }

  type Status {
    id: ID!
    name: String!
    emoji: String!
    isDefault: Boolean
    isCustom: Boolean
  }

  type CustomStatus {
    id: ID!
    name: String!
    emoji: String!
    isPremium: Boolean!
  }

  type StatusSlots {
    freeUsed: Int!
    freeTotal: Int!
    premiumUsed: Int!
    premiumTotal: Int!
  }

  # Connection types
  type Connection {
    id: ID!
    type: ConnectionType!
    status: ConnectionStatus!
    nickname: String
    user: User!
    createdAt: String!
  }

  type ConnectionRequest {
    id: ID!
    type: ConnectionType!
    user: User!
    createdAt: String!
  }

  enum ConnectionType {
    partner
    close_friend
  }

  enum ConnectionStatus {
    pending
    accepted
    rejected
    blocked
  }

  # Notification types
  type Notification {
    id: ID!
    type: NotificationType!
    title: String!
    message: String!
    sender: User
    isRead: Boolean!
    data: String
    createdAt: String!
  }

  type NotificationTemplate {
    id: String!
    title: String!
    message: String!
    emoji: String
  }

  type CustomNotification {
    id: ID!
    title: String!
    message: String!
    isPremium: Boolean!
  }

  enum NotificationType {
    predefined
    custom
    location
    cycle
    status
  }

  # Cycle types
  type Cycle {
    id: ID!
    cycleLength: Int!
    periodLength: Int!
    lastPeriodStart: String
    isTracking: Boolean!
    currentPhase: CyclePhase
    nextPeriod: String
    fertileWindow: FertileWindow
    recentPeriods: [Period!]!
    shareWith: [User!]!
  }

  type CyclePhase {
    phase: String!
    day: Int!
    daysUntilNextPhase: Int
  }

  type FertileWindow {
    start: String!
    end: String!
    ovulationDay: String!
  }

  type Period {
    startDate: String!
    endDate: String
    flow: FlowType
  }

  type Symptom {
    id: ID!
    date: String!
    type: SymptomType!
    severity: Int!
    notes: String
  }

  enum FlowType {
    light
    medium
    heavy
  }

  enum SymptomType {
    cramps
    headache
    mood_swings
    bloating
    fatigue
    breast_tenderness
    acne
    back_pain
    nausea
    cravings
    anxiety
    other
  }

  # Location types
  type Location {
    id: ID!
    latitude: Float!
    longitude: Float!
    address: String
    placeName: String
    timestamp: String!
    isVisit: Boolean
    visitDuration: Int
  }

  type LocationSharing {
    enabled: Boolean!
    shareWith: [User!]!
  }

  # Auth types
  type AuthPayload {
    token: String!
    user: User!
    isNewUser: Boolean!
  }

  type Profile {
    id: ID!
    name: String!
    phone: String
    email: String
    avatar: String
    isPremium: Boolean!
    status: Status
    customStatuses: [CustomStatus!]!
    customNotifications: [CustomNotification!]!
  }

  # Query type
  type Query {
    # User queries
    me: Profile!
    user(id: ID!): User
    searchUser(phone: String, email: String): User

    # Connection queries
    connections: [Connection!]!
    pendingRequests: [ConnectionRequest!]!

    # Status queries
    statuses: StatusesResponse!
    currentStatus: Status

    # Notification queries
    notifications(limit: Int): NotificationsResponse!
    notificationTemplates: NotificationTemplatesResponse!

    # Cycle queries
    cycle: Cycle
    userCycle(userId: ID!): Cycle
    symptoms(startDate: String, endDate: String): [Symptom!]!

    # Location queries
    locationSharing: LocationSharing!
    userLocation(userId: ID!): Location
    userLocationHistory(userId: ID!, startDate: String, endDate: String): [Location!]!
    myLocationHistory(startDate: String, endDate: String): [Location!]!
  }

  type StatusesResponse {
    defaultStatuses: [Status!]!
    customStatuses: [CustomStatus!]!
    slots: StatusSlots!
  }

  type NotificationsResponse {
    notifications: [Notification!]!
    unreadCount: Int!
  }

  type NotificationTemplatesResponse {
    predefinedTemplates: [NotificationTemplate!]!
    customTemplates: [CustomNotification!]!
    slots: StatusSlots!
  }

  # Mutation type
  type Mutation {
    # Auth mutations
    register(name: String!, phone: String, email: String): AuthPayload!
    login(phone: String, email: String): AuthPayload!
    updateProfile(name: String, avatar: String): User!
    updateFcmToken(token: String!): Boolean!

    # Connection mutations
    sendConnectionRequest(userId: ID!, type: ConnectionType!): Connection!
    acceptConnection(connectionId: ID!): Connection!
    rejectConnection(connectionId: ID!): Boolean!
    removeConnection(connectionId: ID!): Boolean!
    blockConnection(connectionId: ID!): Boolean!
    updateNickname(connectionId: ID!, nickname: String!): Connection!

    # Status mutations
    setStatus(statusId: ID!): Status!
    setCustomStatus(customStatusId: ID!): Status!
    createCustomStatus(name: String!, emoji: String): CustomStatus!
    createPremiumCustomStatus(name: String!, emoji: String): CustomStatus!
    updateCustomStatus(statusId: ID!, name: String, emoji: String): CustomStatus!
    deleteCustomStatus(statusId: ID!): Boolean!

    # Notification mutations
    sendPredefinedNotification(receiverId: ID!, templateId: String!): Notification!
    sendCustomNotification(receiverId: ID!, customNotificationId: ID!): Notification!
    createCustomNotification(title: String!, message: String!): CustomNotification!
    createPremiumCustomNotification(title: String!, message: String!): CustomNotification!
    markNotificationsAsRead(notificationIds: [ID!]!): Boolean!
    markAllNotificationsAsRead: Boolean!

    # Cycle mutations
    startPeriod(date: String, flow: FlowType): Period!
    endPeriod(date: String): Period!
    logPeriod(startDate: String!, endDate: String, flow: FlowType): Period!
    logSymptom(date: String, type: SymptomType!, severity: Int, notes: String): Symptom!
    updateCycleSettings(cycleLength: Int, periodLength: Int, isTracking: Boolean): Cycle!
    updateCycleSharing(shareWith: [ID!]!): Cycle!

    # Location mutations
    updateLocation(latitude: Float!, longitude: Float!, address: String, placeName: String): Location!
    updateLocationSharing(enabled: Boolean!, shareWith: [ID!]): LocationSharing!
  }

  # Subscription type (for real-time updates)
  type Subscription {
    notificationReceived: Notification!
    statusUpdated(userId: ID!): StatusUpdate!
    connectionUpdated: ConnectionUpdate!
    cycleUpdated(userId: ID!): CycleUpdate!
    locationUpdated(userId: ID!): Location!
  }

  type StatusUpdate {
    userId: ID!
    userName: String!
    status: Status!
  }

  type ConnectionUpdate {
    type: String!
    connection: Connection
    connectionId: ID
  }

  type CycleUpdate {
    userId: ID!
    userName: String!
    type: String!
    currentPhase: CyclePhase
  }
`;

module.exports = typeDefs;
