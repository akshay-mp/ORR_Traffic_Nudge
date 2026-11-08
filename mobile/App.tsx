import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/state/appStore';
import { RootNavigator } from './src/navigation';
import { OnboardingModal } from './src/screens/OnboardingModal';
import { usePalette } from './src/theme';

function AppShell() {
  const scheme = useColorScheme();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { state } = useApp();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: p.background,
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
      <OnboardingModal
        visible={state.hydrated && state.mode === 'DEMO' && !state.demo.onboardingAcknowledged}
      />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <AppShell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
