/** Bottom tab navigation: Today, Plan, Trips, Settings. */
import React from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useColorScheme } from 'react-native';
import { usePalette } from '../theme';
import { TodayScreen } from '../screens/TodayScreen';
import { PlanScreen } from '../screens/PlanScreen';
import { TripsScreen } from '../screens/TripsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

export type AppTabParamList = {
  Today: undefined;
  Plan: undefined;
  Trips: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<AppTabParamList>();

export function RootNavigator() {
  const scheme = useColorScheme();
  const p = usePalette();
  const theme = scheme === 'dark'
    ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: p.background, card: p.surface, text: p.ink, primary: p.primary, border: p.border } }
    : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: p.background, card: p.surface, text: p.ink, primary: p.primary, border: p.border } };

  return (
    <NavigationContainer theme={theme}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: p.primary,
          tabBarInactiveTintColor: p.inkMuted,
          tabBarIcon: ({ color, size, focused }) => {
            const icons: Record<keyof AppTabParamList, React.ComponentProps<typeof Ionicons>['name']> = {
              Today: focused ? 'today' : 'today-outline',
              Plan: focused ? 'calendar' : 'calendar-outline',
              Trips: focused ? 'bus' : 'bus-outline',
              Settings: focused ? 'settings' : 'settings-outline',
            };
            return <Ionicons name={icons[route.name as keyof AppTabParamList]} size={size} color={color} />;
          },
        })}
      >
        <Tab.Screen
          name="Today"
          component={TodayScreen}
          options={{ tabBarAccessibilityLabel: 'Today: departure recommendations and alerts' }}
        />
        <Tab.Screen
          name="Plan"
          component={PlanScreen}
          options={{ tabBarAccessibilityLabel: 'Plan: places and weekly schedules' }}
        />
        <Tab.Screen
          name="Trips"
          component={TripsScreen}
          options={{ tabBarAccessibilityLabel: 'Trips: journey history and corrections' }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ tabBarAccessibilityLabel: 'Settings: connection, privacy and demo reset' }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
