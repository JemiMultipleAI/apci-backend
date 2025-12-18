-- Add Contact Groups feature
-- Contact groups allow contacts to be organized into reusable groups for campaign targeting
-- A contact can belong to multiple groups (many-to-many relationship)

-- Contact Groups table
CREATE TABLE IF NOT EXISTS contact_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Many-to-many relationship: contacts can belong to multiple groups
CREATE TABLE IF NOT EXISTS contact_group_members (
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    contact_group_id UUID REFERENCES contact_groups(id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (contact_id, contact_group_id)
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact_id ON contact_group_members(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_group_members_group_id ON contact_group_members(contact_group_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_account_id ON contact_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_created_by ON contact_groups(created_by);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_contact_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_contact_groups_updated_at
    BEFORE UPDATE ON contact_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_contact_groups_updated_at();

