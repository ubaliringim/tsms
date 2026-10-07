import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        TSMS Student
      </Text>
      <Text>Learning experiences are not available yet.</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 32,
    gap: 16,
    backgroundColor: '#ffffff',
  },
  title: { fontSize: 28, fontWeight: '600', color: '#142d24' },
});
