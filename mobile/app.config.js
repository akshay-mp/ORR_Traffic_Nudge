const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    ...(projectId
      ? { eas: { ...config.extra?.eas, projectId } }
      : {}),
  },
});
