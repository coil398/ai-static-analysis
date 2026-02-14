// Example code with various complexity issues

// Simple function - low complexity
function add(a, b) {
  return a + b;
}

// Medium complexity function
function calculateDiscount(price, customerType) {
  let discount = 0;
  
  if (customerType === 'premium') {
    if (price > 100) {
      discount = 0.2;
    } else {
      discount = 0.1;
    }
  } else if (customerType === 'regular') {
    if (price > 200) {
      discount = 0.15;
    } else if (price > 100) {
      discount = 0.1;
    }
  }
  
  return price * (1 - discount);
}

// High complexity function - needs refactoring
function processOrder(order, user, inventory) {
  if (!order) {
    return null;
  }
  
  if (!user) {
    throw new Error('User required');
  }
  
  if (!inventory) {
    throw new Error('Inventory required');
  }
  
  let total = 0;
  
  for (let item of order.items) {
    if (!item.id) {
      continue;
    }
    
    let stockItem = inventory.find(i => i.id === item.id);
    
    if (!stockItem) {
      console.log('Item not found:', item.id);
      continue;
    }
    
    if (stockItem.quantity < item.quantity) {
      if (stockItem.allowBackorder) {
        console.log('Backordering:', item.id);
      } else {
        throw new Error('Insufficient stock');
      }
    }
    
    let price = stockItem.price;
    
    if (item.quantity > 10) {
      price = price * 0.9;
    } else if (item.quantity > 5) {
      price = price * 0.95;
    }
    
    if (user.isPremium) {
      if (stockItem.category === 'electronics') {
        price = price * 0.85;
      } else if (stockItem.category === 'clothing') {
        price = price * 0.9;
      }
    }
    
    total += price * item.quantity;
  }
  
  if (user.credits > 0) {
    if (user.credits >= total) {
      user.credits -= total;
      total = 0;
    } else {
      total -= user.credits;
      user.credits = 0;
    }
  }
  
  return total;
}

// Very long function
function complexBusinessLogic(data) {
  let result = [];
  let counter = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (data[i].active) {
      if (data[i].type === 'A') {
        if (data[i].value > 100) {
          result.push(data[i]);
          counter++;
        }
      } else if (data[i].type === 'B') {
        if (data[i].value > 50) {
          if (data[i].priority === 'high') {
            result.push(data[i]);
            counter++;
          }
        }
      }
    }
  }
  
  // More nested logic...
  if (counter > 10) {
    result = result.filter(item => {
      if (item.category === 'premium') {
        if (item.score > 80) {
          return true;
        }
      } else if (item.category === 'standard') {
        if (item.score > 60) {
          if (item.verified) {
            return true;
          }
        }
      }
      return false;
    });
  }
  
  return result;
}
