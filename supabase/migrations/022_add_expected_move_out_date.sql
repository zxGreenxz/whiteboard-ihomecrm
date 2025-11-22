
-- Add expected_move_out_date to contracts table
ALTER TABLE contracts 
ADD COLUMN expected_move_out_date DATE;

CREATE INDEX idx_contracts_expected_move_out_date ON contracts(expected_move_out_date);
