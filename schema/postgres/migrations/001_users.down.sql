-- Drop trigger and function for updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop users table
DROP TABLE IF EXISTS users;
